import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type {
  EffectiveLaunchConfig,
  EnvironmentQualificationBindingV1,
  ExecutionRequirements,
  Pod,
} from '@autopod/shared';
import Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import {
  type EnvironmentQualificationInput,
  QUALIFICATION_SOURCE_PROBE,
  qualificationExecutionContextHash,
  qualifyExecutionEnvironment,
} from './environment-qualification.js';
import { createProvisioningWorkspacePopulation } from './provisioning-workspace-population.js';
import { WORKSPACE_FILE_SNAPSHOT_SCRIPT } from './workspace-file-observer.js';

/** Opt-in, cached immutable image + explicit LOCAL socket only. Never pulls/builds images.
 * AUTOPOD_QUALIFICATION_DOCKER_IMAGE=sha256:... AUTOPOD_QUALIFICATION_DOCKER_SOCKET=/.../docker.sock
 * AUTOPOD_QUALIFICATION_DOCKER_RECEIPTS=/absolute/retained/log/dir pnpm exec vitest run ... --maxWorkers=1
 * Uses actual production population and Docker exec/identity/metadata, not mock receipts.
 */
it.skipIf(!process.env.AUTOPOD_QUALIFICATION_DOCKER_IMAGE)(
  'qualifies a real isolated Docker resource with production Git materialization; refuses missing launchers, wrong identities and hidden source changes',
  async () => {
    const image = process.env.AUTOPOD_QUALIFICATION_DOCKER_IMAGE;
    const socketPath = process.env.AUTOPOD_QUALIFICATION_DOCKER_SOCKET;
    const receipts = process.env.AUTOPOD_QUALIFICATION_DOCKER_RECEIPTS;
    if (
      !image ||
      !/^sha256:[a-f0-9]{64}$/.test(image) ||
      !socketPath ||
      !isAbsolute(socketPath) ||
      !receipts ||
      !isAbsolute(receipts)
    )
      throw new Error(
        'Explicit cached immutable image ID, local socket and retained receipt directory required',
      );
    mkdirSync(receipts, { recursive: true });
    const run = randomUUID();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'autopod-qualification-docker-')));
    const seed = join(root, 'seed');
    const bare = join(root, 'bare.git');
    const worktree = join(root, 'source');
    const logPath = join(receipts, `${run}.json`);
    const docker = new Dockerode({ socketPath, timeout: 15_000 });
    const record: Record<string, unknown> = {
      run,
      image,
      root,
      syntheticOnly: true,
      stages: [],
      cleanup: 'not_started',
    };
    const stages = record.stages as Array<Record<string, unknown>>;
    const commands: Array<{
      command: string[];
      user?: string;
      cwd?: string;
      result?: { exitCode: number; stdout: string; stderr: string };
      error?: string;
    }> = [];
    record.commands = commands;
    const save = () => writeFileSync(logPath, `${JSON.stringify(record, null, 2)}\n`);
    let container: Dockerode.Container | undefined;
    let current = true;
    let streamingAttempts = 0;
    let modelAttempts = 0;
    const assertCurrent = () => {
      if (!current) throw new Error('Disposable fixture no longer owned');
    };
    const gitEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 10000 }).trim();
    const cleanup = async () => {
      if (container) {
        const inspection = await container.inspect();
        if (inspection.Config.Labels?.['autopod.fixture.run'] !== run) {
          record.cleanup = 'refused_unowned_container';
          save();
          throw new Error('Refusing cleanup of an unowned container');
        }
        record.cleanup = 'removing_owned_fixture';
        save();
        await container.remove({ force: true, v: true });
        await expect(container.inspect()).rejects.toMatchObject({ statusCode: 404 });
        record.cleanup = {
          removedContainerId: container.id,
          observedDocker404: true,
          removedSyntheticRoot: root,
        };
        save();
      }
      rmSync(root, { recursive: true, force: true });
      console.info(`Qualification Docker fixture receipts: ${logPath}`);
    };
    try {
      const info = await docker.getImage(image).inspect(); // Inspect ONLY caller-selected existing image.
      expect(info.Id).toBe(image);
      expect(info.Os).toBe('linux');
      if (info.Architecture !== 'amd64' && info.Architecture !== 'arm64')
        throw new Error('Unsupported fixture image architecture');
      const platform = `linux/${info.Architecture}` as 'linux/amd64' | 'linux/arm64';
      record.imageIdentity = {
        id: info.Id,
        platform,
        configuredUser: info.Config?.User,
        originalEntrypoint: info.Config?.Entrypoint,
      };
      mkdirSync(seed);
      git(seed, 'init', '--quiet');
      mkdirSync(join(seed, 'pkg'));
      writeFileSync(join(seed, 'README.md'), 'Synthetic qualification input only\n');
      writeFileSync(join(seed, 'pkg/source.txt'), 'selected synthetic bytes\n');
      writeFileSync(join(seed, '.gitattributes'), 'pkg/source.txt filter=reviewprobe\n');
      git(seed, 'add', '.');
      git(
        seed,
        '-c',
        'user.name=Qualification fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'synthetic selected input',
      );
      git(root, 'clone', '--bare', '--no-hardlinks', seed, bare);
      git(root, '--git-dir', bare, 'worktree', 'add', '-b', `fixture-${run}`, worktree);
      const head = git(worktree, 'rev-parse', 'HEAD');
      const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
      const originalGitlink = readFileSync(join(worktree, '.git'), 'utf8');
      expect(originalGitlink.startsWith('gitdir: ')).toBe(true);
      const memoryBytes = 1024 ** 3;
      // Explicitly scrub image environment values, then set ONLY known non-secret fixture context.
      const env = new Map((info.Config?.Env ?? []).map((value) => [value.split('=')[0] ?? '', '']));
      env.set('HOME', '/tmp/qualification-home');
      env.set(
        'PATH',
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/autopod/.local/bin',
      );
      env.set('NODE_ENV', 'development');
      const labels = {
        'autopod.fixture': 'repair-qualification-smoke',
        'autopod.fixture.run': run,
      };
      container = await docker.createContainer({
        name: `autopod-qualification-smoke-${run}`,
        Image: image,
        Entrypoint: ['/bin/sleep'],
        Cmd: ['300'],
        User: 'autopod',
        WorkingDir: '/workspace',
        Env: [...env].filter(([key]) => key).map(([key, value]) => `${key}=${value}`),
        Labels: labels,
        HostConfig: {
          NetworkMode: 'none',
          Memory: memoryBytes,
          MemorySwap: memoryBytes,
          NanoCpus: 1e9,
          PidsLimit: 128,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Binds: [`${worktree}:/mnt/worktree:ro`, `${bare}:${bare}:ro`],
        },
      });
      const containerId = container.id;
      record.containerId = containerId;
      record.labels = labels;
      save(); // Durable before starting fixture.
      await container.start();
      const cm = new DockerContainerManager({ docker, logger: pino({ level: 'silent' }) });
      const execute = cm.execInContainer.bind(cm);
      // Observation/safety wrapper ONLY: all dispatched exec/identity/metadata results remain real.
      cm.execInContainer = async (id, command, options) => {
        const trace: (typeof commands)[number] = {
          command,
          ...(options?.user ? { user: options.user } : {}),
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        };
        commands.push(trace);
        if (
          ['claude', 'codex', 'copilot', 'pi'].includes(basename(command[0] ?? '')) &&
          (command.length !== 2 || command[1] !== '--version')
        ) {
          modelAttempts++;
          throw new Error('No native coding/model command is allowed in this fixture');
        }
        try {
          const result = await execute(id, command, options);
          trace.result = {
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, 8192),
            stderr: result.stderr.slice(0, 8192),
          };
          return result;
        } catch (error) {
          trace.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      cm.execStreaming = async () => {
        streamingAttempts++;
        throw new Error('No agent stream is allowed in this fixture');
      };
      const checkedExec = async (command: string[]) => {
        const result = await cm.execInContainer(containerId, command, {
          user: 'autopod',
          timeout: 15000,
          maxOutputBytes: 65536,
          assertCurrent,
        });
        stages.push({ preparationCommand: command, result });
        save();
        expect(result.exitCode, result.stderr).toBe(0);
        return result;
      };
      await checkedExec(['/bin/sh', '-c', 'mkdir -p /tmp/qualification-home; id -u']);
      const profile = {
        containerMemoryGb: 1,
        buildWorkDir: 'pkg',
        buildEnv: { NODE_ENV: 'development' },
        codeIntelligence: null,
      } as PodExecutionSettings;
      const pod = {
        id: `fixture-${run}`,
        runtime: 'claude',
        model: 'test',
        executionTarget: 'local',
        status: 'provisioning',
        lifecycleGeneration: 2,
        branch: `fixture-${run}`,
        options: { validate: false },
      } as Pod;
      // Invoke the ACTUAL production copy/gitlink->standalone .git + alternates/restore/clean sequence.
      const population = createProvisioningWorkspacePopulation(
        {},
        {
          podRepo: {} as never,
          fixFeedbackRepo: {} as never,
          buildPrFixTask: (() => {
            throw new Error('No fix worker');
          }) as never,
          logger: pino({ level: 'silent' }),
          transition: (p, status, updates) => ({ ...p, status, ...updates }),
        },
      );
      const populated = await population.populateWorkspace({
        podId: pod.id,
        pod,
        profile,
        worktreePath: worktree,
        containerId: container.id,
        containerManager: cm,
        stagedReferenceRepos: new Map(),
        frozenReferences: new Map(),
        run: { emitStatus() {} },
      } as Parameters<typeof population.populateWorkspace>[0]);
      expect(populated.pod.status).toBe('running');
      const layout = await checkedExec([
        '/usr/local/bin/node',
        '-e',
        `const fs=require('node:fs'); process.stdout.write(JSON.stringify({gitDirectory:fs.lstatSync('/workspace/.git').isDirectory(),commondir:fs.existsSync('/workspace/.git/commondir'),alternates:fs.readFileSync('/workspace/.git/objects/info/alternates','utf8').trim()}))`,
      ]);
      expect(JSON.parse(layout.stdout)).toEqual({
        gitDirectory: true,
        commondir: false,
        alternates: `${bare}/objects`,
      });
      const resourceKey = await cm.getResourceKey(container.id);
      const inputFor = (executables: string[]): EnvironmentQualificationInput => {
        const requirements: ExecutionRequirements = {
          version: 2,
          executables,
          minimumMemoryBytes: memoryBytes,
          minimumCpu: 1,
          platform,
        };
        const body = {
          schemaVersion: 1,
          work: { contract: { executionRequirements: requirements } },
          repository: { config: { remote: 'https://example.invalid/synthetic-fixture' } },
          references: [],
          execution: { target: 'local' },
          resolvedEnvironment: { platform },
          resolvedExecution: { main: { memoryGb: 1, cpus: 1 } },
        };
        const launchConfig = {
          ...body,
          digest: configurationDigest(body),
        } as unknown as EffectiveLaunchConfig;
        const boundPod = {
          ...populated.pod,
          launchConfigDigest: launchConfig.digest,
          contract: { executionRequirements: requirements },
        } as Pod;
        const hash = configurationDigest({ run });
        const binding: EnvironmentQualificationBindingV1 = {
          version: 1,
          operationId: `smoke-${run}`,
          requestHash: hash,
          podId: pod.id,
          taskId: 'synthetic-task',
          executionId: 'synthetic-execution',
          custodyId: 'synthetic-custody',
          originalGeneration: 1,
          candidateGeneration: 2,
          originalResultHash: hash,
          reportSetHash: hash,
          requirementsHash: configurationDigest(requirements),
          originalLaunchDigest: hash,
          replacementLaunchDigest: launchConfig.digest,
          configurationHash: configurationDigest(profile),
          sourceEpoch: hash,
          credentialEpoch: hash,
          resourceEpoch: hash,
          source: {
            repository: 'https://example.invalid/synthetic-fixture',
            head,
            tree,
            baseCommitSha: head,
          },
          target: 'local',
          containerId,
          resourceKey,
          expectedImage: { kind: 'docker-image-id', digest: image },
          platform,
          executionContextHash: qualificationExecutionContextHash(profile),
        };
        return {
          binding,
          pod: boundPod,
          profile,
          launchConfig,
          containerManager: cm,
          preparationCompleted: true,
          assertCurrent,
        };
      };
      const qualify = async (name: string, input: EnvironmentQualificationInput) => {
        const result = await qualifyExecutionEnvironment(input);
        stages.push({ name, result });
        save(); // Preserve actual failures BEFORE assertions/cleanup.
        return result.evidence;
      };
      // Simulate allowed repository preparation configuring an executable clean filter.
      // It returns canonical bytes while corrupting source on its SECOND invocation.
      // Qualification/observer/pre-dispatch observations must never execute it at all.
      await cm.writeFile(
        containerId,
        '/workspace/.git/review-filter.sh',
        `#!/bin/sh
cat >/dev/null
count=$(cat /workspace/.git/filter-count 2>/dev/null || echo 0)
count=$((count+1))
printf '%s' "$count" > /workspace/.git/filter-count
if [ "$count" -ge 2 ]; then printf 'corrupted by configured filter\\n' > /workspace/pkg/source.txt; fi
printf 'selected synthetic bytes\\n'
printf executed > /workspace/.git/filter-ran
`,
        { mode: 0o755 },
      );
      await checkedExec([
        '/usr/bin/git',
        '-C',
        '/workspace',
        'config',
        'filter.reviewprobe.clean',
        '/workspace/.git/review-filter.sh',
      ]);
      await checkedExec([
        '/usr/local/bin/node',
        '-e',
        `require('node:fs').utimesSync('/workspace/pkg/source.txt',new Date('2030-01-01'),new Date('2030-01-01'))`,
      ]);
      const positive = await qualify('positive', inputFor(['git']));
      expect(positive.outcome, JSON.stringify(positive.observations)).toBe('qualified');
      for (const prerequisite of [
        'resource_identity',
        'image',
        'memory',
        'cpu',
        'platform',
        'source',
        'agent_cli',
        'launcher',
      ])
        expect(positive.observations).toContainEqual(
          expect.objectContaining({ prerequisite, outcome: 'qualified' }),
        );
      const observer = await cm.execInContainer(
        containerId,
        ['/usr/local/bin/node', '-e', WORKSPACE_FILE_SNAPSHOT_SCRIPT],
        {
          user: 'autopod',
          cwd: '/workspace',
          timeout: 10_000,
          maxOutputBytes: 4 * 1024 * 1024,
          assertCurrent,
        },
      );
      expect(observer.exitCode, observer.stderr).toBe(0);
      expect(JSON.parse(observer.stdout)).toMatchObject({ version: 1, complete: true });
      const indexBeforeRedispatch = await cm.readFileBinary(containerId, '/workspace/.git/index');
      const redispatch = await cm.execInContainer(
        containerId,
        ['/usr/local/bin/node', '-e', QUALIFICATION_SOURCE_PROBE, head],
        {
          user: 'autopod',
          cwd: '/workspace/pkg',
          env: profile.buildEnv ?? undefined,
          timeout: 10_000,
          maxOutputBytes: 65536,
          assertCurrent,
        },
      );
      stages.push({ name: 'source-redispatch-after-observer', result: redispatch });
      save();
      expect(redispatch.exitCode, redispatch.stderr).toBe(0);
      expect(JSON.parse(redispatch.stdout)).toMatchObject({
        head,
        tree,
        clean: true,
        baseAncestor: true,
        uid: 1000,
        platform,
      });
      expect(await cm.readFileBinary(containerId, '/workspace/.git/index')).toEqual(
        indexBeforeRedispatch,
      );
      const filterState = async () => {
        const state = await checkedExec([
          '/usr/local/bin/node',
          '-e',
          `const fs=require('node:fs'); process.stdout.write(JSON.stringify({executed:fs.existsSync('/workspace/.git/filter-ran'),count:fs.existsSync('/workspace/.git/filter-count')?fs.readFileSync('/workspace/.git/filter-count','utf8'):'0'}))`,
        ]);
        return JSON.parse(state.stdout);
      };
      expect(await filterState()).toEqual({ executed: false, count: '0' });
      expect(await cm.readFile(containerId, '/workspace/pkg/source.txt')).toBe(
        'selected synthetic bytes\n',
      );
      for (const key of ['smudge', 'process', 'required'])
        await checkedExec([
          '/usr/bin/git',
          '-C',
          '/workspace',
          'config',
          `filter.reviewprobe.${key}`,
          key === 'required' ? 'true' : '/workspace/.git/review-filter.sh',
        ]);
      const filterConfig = await cm.readFile(containerId, '/workspace/.git/config');
      const indexWithProcess = await cm.readFileBinary(containerId, '/workspace/.git/index');
      expect(
        (await qualify('clean-smudge-process-required-neutralized', inputFor(['git']))).outcome,
      ).toBe('qualified');
      expect(await cm.readFile(containerId, '/workspace/.git/config')).toBe(filterConfig);
      expect(await cm.readFileBinary(containerId, '/workspace/.git/index')).toEqual(
        indexWithProcess,
      );
      expect(await filterState()).toEqual({ executed: false, count: '0' });
      const missing = await qualify(
        'missing-launcher',
        inputFor([`autopod_missing_${run.replaceAll('-', '_')}`]),
      );
      expect(missing.outcome).not.toBe('qualified');
      expect(missing.observations).toContainEqual(
        expect.objectContaining({ prerequisite: 'launcher', outcome: 'failed' }),
      );
      const wrongImage = inputFor(['git']);
      wrongImage.binding.expectedImage.digest = `sha256:${'f'.repeat(64)}`;
      expect((await qualify('wrong-image', wrongImage)).outcome).toBe('failed');
      const wrongResource = inputFor(['git']);
      wrongResource.binding.resourceKey += '-not-the-reservation';
      const beforeWrongResource = commands.length;
      expect((await qualify('wrong-resource', wrongResource)).outcome).toBe('failed');
      expect(commands).toHaveLength(beforeWrongResource);
      // This is fixture mutation, not attestation. Do not execute the deliberately
      // hostile filters while arranging the hidden-dirty negative source case.
      await checkedExec([
        '/usr/bin/git',
        '--no-replace-objects',
        '-C',
        '/workspace',
        '-c',
        'filter.reviewprobe.clean=',
        '-c',
        'filter.reviewprobe.smudge=',
        '-c',
        'filter.reviewprobe.process=',
        '-c',
        'filter.reviewprobe.required=false',
        'update-index',
        '--assume-unchanged',
        'pkg/source.txt',
      ]);
      await cm.writeFile(container.id, '/workspace/pkg/source.txt', 'changed synthetic bytes\n');
      expect(
        (
          await checkedExec([
            '/usr/bin/git',
            '--no-replace-objects',
            '-C',
            '/workspace',
            '-c',
            'filter.reviewprobe.clean=',
            '-c',
            'filter.reviewprobe.smudge=',
            '-c',
            'filter.reviewprobe.process=',
            '-c',
            'filter.reviewprobe.required=false',
            'status',
            '--porcelain',
          ])
        ).stdout.trim(),
      ).toBe('');
      const changed = await qualify('hidden-changed-source', inputFor(['git']));
      expect(changed.outcome).toBe('failed');
      expect(changed.observations).toContainEqual(
        expect.objectContaining({ prerequisite: 'source', outcome: 'failed' }),
      );
      expect(await filterState()).toEqual({ executed: false, count: '0' });
      await cm.writeFile(containerId, '/workspace/pkg/source.txt', 'selected synthetic bytes\n');
      const unrelated = (
        await checkedExec([
          '/usr/bin/git',
          '--no-replace-objects',
          '-C',
          '/workspace',
          'commit-tree',
          tree,
          '-m',
          'unrelated selected B',
        ])
      ).stdout.trim();
      const replacement = (
        await checkedExec([
          '/usr/bin/git',
          '--no-replace-objects',
          '-C',
          '/workspace',
          'commit-tree',
          tree,
          '-p',
          head,
          '-m',
          'fake A parent C',
        ])
      ).stdout.trim();
      await checkedExec(['/usr/bin/git', '-C', '/workspace', 'update-ref', 'HEAD', unrelated]);
      await checkedExec(['/usr/bin/git', '-C', '/workspace', 'replace', unrelated, replacement]);
      const rawAncestry = await cm.execInContainer(
        containerId,
        [
          '/usr/bin/git',
          '--no-replace-objects',
          '-C',
          '/workspace',
          'merge-base',
          '--is-ancestor',
          head,
          unrelated,
        ],
        { user: 'autopod', timeout: 10000, maxOutputBytes: 65536, assertCurrent },
      );
      stages.push({ name: 'real-unrelated-ancestry', result: rawAncestry });
      save();
      expect(rawAncestry.exitCode).toBe(1);
      await checkedExec([
        '/usr/bin/git',
        '-C',
        '/workspace',
        'merge-base',
        '--is-ancestor',
        head,
        unrelated,
      ]); // Demonstrate adversarial default view.
      const ancestryInput = inputFor(['git']);
      ancestryInput.binding.source.head = unrelated;
      const ancestry = await qualify('replacement-ref-false-ancestry', ancestryInput);
      expect(ancestry.outcome).not.toBe('qualified');
      expect(ancestry.observations).toContainEqual(
        expect.objectContaining({ prerequisite: 'source', outcome: 'unknown' }),
      );
      expect(await filterState()).toEqual({ executed: false, count: '0' });
      expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(originalGitlink);
      expect(readFileSync(join(worktree, 'pkg/source.txt'), 'utf8')).toBe(
        'selected synthetic bytes\n',
      );
      const observed = await container.inspect();
      record.finalContainer = {
        id: observed.Id,
        path: observed.Path,
        args: observed.Args,
        user: observed.Config.User,
        networkMode: observed.HostConfig.NetworkMode,
        memory: observed.HostConfig.Memory,
        cpu: observed.HostConfig.NanoCpus,
        binds: observed.HostConfig.Binds,
        ports: observed.NetworkSettings.Ports,
        labels: observed.Config.Labels,
      };
      expect(observed.Path).toBe('/bin/sleep');
      expect(observed.Args).toEqual(['300']);
      expect(observed.HostConfig.NetworkMode).toBe('none');
      expect(observed.HostConfig.PortBindings ?? {}).toEqual({});
      expect(observed.HostConfig.Memory).toBe(memoryBytes);
      expect(observed.HostConfig.NanoCpus).toBe(1e9);
      expect(streamingAttempts).toBe(0);
      expect(modelAttempts).toBe(0);
      record.zeroAgentStarts = { streamingAttempts, modelAttempts, mainProcess: observed.Path };
      record.result = 'passed';
      save();
    } catch (error) {
      record.result = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      save();
      throw error;
    } finally {
      current = false;
      // Evidence saved first; cleanup is restricted to the exact owned fixture ID/labels.
      await cleanup();
    }
  },
  120_000,
);
