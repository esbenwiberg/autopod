import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Docker from 'dockerode';
import Fastify from 'fastify';
import pino from 'pino';
import { expect, it } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { DockerNetworkManager } from '../containers/docker-network-manager.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { registerManagedComponentRoutes } from './bootstrap.js';
import { digest } from './canonical.js';
import { ChatGptReportTransport } from './chatgpt-provider.js';
import { createManagedArtifactStore } from './cli-config.js';
import { ContainerCodexChannel, codexAgentCommand } from './codex-channel.js';
import { composeManagedRuntime } from './runtime-composition.js';
import { ManagedGitBroker } from './source-git.js';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('live-rpi-required-value-missing');
  return value;
}

// Explicit paid opt-in. Credentials stay in the host transport; fixture HTTP authentication
// deliberately does not claim Entra acceptance. No GitHub push or PR is made by this test.
const image = process.env.AUTOPOD_MANAGED_DOCKER_IMAGE;
const authFile = process.env.AUTOPOD_MANAGED_LIVE_AUTH_FILE;
const repository = process.env.AUTOPOD_MANAGED_LIVE_REPOSITORY;
const model = process.env.AUTOPOD_MANAGED_LIVE_MODEL;
it.skipIf(!image || !authFile || !repository || !model)(
  'runs real-model research, planning and implementation with immutable Docker handoffs',
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'autopod-live-rpi-')));
    const f = requestTimeFixture(20, 500000);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const mirror = path.join(root, 'mirror');
    git(root, 'clone', '--no-hardlinks', '--branch', 'main', required(repository), mirror);
    const base = git(mirror, 'rev-parse', 'HEAD');
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', '--no-hardlinks', mirror, remote);
    const docker = new Docker({ socketPath: process.env.AUTOPOD_MANAGED_DOCKER_SOCKET });
    const logger = pino({ level: 'silent' });
    const manager = new DockerContainerManager({ docker, logger });
    const network = new DockerNetworkManager({ docker, logger });
    const store = createManagedArtifactStore(
      { bindings: [], artifactDirectory: path.join(root, 'artifacts') },
      f.db,
    );
    const stages = ['research', 'planning', 'implementation'] as const;
    const nonce = path.basename(root);
    const objectives = [
      `Read this todo repository. Explain its title validation and recommend a standalone normalizeTitle(value) helper in canary-normalize.mjs: trim string input, reject blank and non-string input with TypeError. Do not change files. Include the exact handoff marker ${nonce}. Keep the report under 500 words.`,
      'Use the supplied research artifact and inspect the repository. Plan canary-normalize.mjs exporting normalizeTitle(value), trimming strings and throwing TypeError for blank/non-string input. Include exact tests and reproduce the exact handoff marker from the research artifact. Do not change files. Keep the plan under 500 words.',
      'Implement the supplied plan as canary-normalize.mjs exporting normalizeTitle(value). Add focused Node tests, run them, and commit only your changes. Preserve the existing application. The final report must include the exact handoff marker from the supplied plan, files changed and checks actually run.',
    ];
    const requests = stages.map((stage, index): ManagedPodRequest => {
      const r = structuredClone(f.request);
      r.dispatcherJobId = `${nonce}-${stage}`;
      r.dispatcherAttemptId = `${nonce}-${stage}`;
      r.startKey = `${nonce}-${stage}`;
      r.route = { ...r.route, model: required(model), reasoning: 'low' };
      r.task = { ...r.task, kind: stage, objective: required(objectives[index]) };
      r.profileSnapshot.profileId = stage;
      for (const owner of [r.profileSnapshot, r.effectiveGrant]) {
        owner.route = structuredClone(r.route);
        required(owner.scope.repositories[0]).baseRevision = base;
        required(owner.scope.repositories[0]).remote = 'origin';
        owner.budget.expiresAt = Math.floor(Date.now() / 1000) + 1800;
        owner.budget.maxDurationSeconds = 480;
        if (stage === 'implementation') {
          required(owner.scope.repositories[0]).access = 'write';
          owner.scope.allowedEffects.push('git.commit', 'git.push.worker-branch', 'test.run');
        }
      }
      r.profileSnapshot.snapshotDigest = digest(
        Object.fromEntries(
          Object.entries(r.profileSnapshot).filter(([k]) => k !== 'snapshotDigest'),
        ),
      );
      r.effectiveGrant.profileSnapshotDigest = r.profileSnapshot.snapshotDigest;
      r.effectiveGrant.dispatcherAttemptId = r.dispatcherAttemptId;
      r.effectiveGrant.grantId = `${nonce}-${stage}`;
      r.outputs.artifacts.requiredPaths = [`${stage}.md`];
      r.outputs.artifacts.include = [`${stage}.md`];
      r.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 65536, maxTotalBytes: 65536 };
      if (stage === 'implementation') {
        r.outputs.source = {
          mode: 'branch',
          repository: 'fixture-repo',
          remote: 'origin',
          base: 'main',
          head: `dispatcher/workers/${nonce}`,
        };
        r.validation = { suite: 'full', verifierPolicy: 'live-rpi-independent-v1' };
      }
      return resign(r);
    });
    const source = {
      git: new ManagedGitBroker([
        {
          repository: 'fixture-repo',
          remote: 'origin',
          remoteUrl: remote,
          base: 'main',
          baseCommit: base,
          branchNamespace: 'dispatcher/workers/',
          workspace: (podId) => path.join(root, 'state', 'workspaces', podId, 'fixture-repo'),
        },
      ]),
      verifierIdentities: new Map([['live-rpi-independent-v1', 'live-rpi-oracle']]),
    };
    const credential = async () => {
      const auth = JSON.parse(readFileSync(required(authFile), 'utf8'));
      if (!auth.tokens?.access_token || !auth.tokens?.account_id)
        throw new Error('live-auth-unavailable');
      return {
        accountId: required(requests[0]).route.providerAccountId,
        mode: 'chatgpt' as const,
        chatgptAccountId: auth.tokens.account_id as string,
        token: auth.tokens.access_token as string,
      };
    };
    const initial = await credential();
    let providerRequests = 0;
    const components = composeManagedRuntime({
      db: f.db,
      enabled: true,
      store,
      source,
      stateRoot: path.join(root, 'state'),
      runtimeCapabilities: ['managed-agent-session-v1'],
      admission: {
        ...f.admission,
        profiles: new Map(
          requests.map((r) => [r.profileSnapshot.snapshotDigest, r.profileSnapshot]),
        ),
        enrollmentCeiling: required(requests[2]).profileSnapshot.scope,
        identityCeiling: required(requests[2]).profileSnapshot.scope,
        backendCeiling: required(requests[2]).profileSnapshot.scope,
      },
      mirrors: [
        { enrollmentId: 'fixture-repo', path: mirror, remote: 'origin', baseRevision: base },
      ],
      bindings: requests.map((r, index) => ({
        profileId: r.profileSnapshot.profileId,
        route: r.route,
        manager,
        image: required(image),
        command: codexAgentCommand(
          r.route,
          'fixture-repo',
          `${stages[index]}.md`,
          index === 2,
          index ? [required(stages[index - 1])] : [],
        ),
        transport: new ChatGptReportTransport(
          r.route,
          initial.chatgptAccountId,
          credential,
          async (...args) => {
            providerRequests++;
            return fetch(...args);
          },
          undefined,
          'agent',
        ),
        channel: new ContainerCodexChannel(manager, r.route, 0, {
          mode: 'agent',
          maximumDurationSeconds: 480,
        }),
        maximumRequests: 20,
        network: async (_request, podId) => ({
          networkName: await network.ensureNetworkForPod(podId),
          firewallScript: await network.generateFirewallScript(
            [],
            'deny-all',
            undefined,
            [],
            3100,
            false,
          ),
        }),
        cleanupNetwork: (podId) => network.removeNetworkForPod(podId),
      })),
    });
    const app = Fastify();
    registerManagedComponentRoutes(app, components, { db: f.db, store }, async (r) =>
      r.headers.authorization === 'Bearer fixture-only' ? 'installation' : null,
    );
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { 'content-type': 'application/json', authorization: 'Bearer fixture-only' };
    const handles: Array<{ podId: string; request: ManagedPodRequest }> = [];
    const receipts: unknown[] = [];
    let failure: string | null = null;
    const diagnostics: unknown[] = [];
    try {
      for (const [index, request] of requests.entries()) {
        if (index) {
          const previous = required(handles[index - 1]);
          const artifact = required(
            components.controls.observe('installation', previous.podId, '0').result.artifacts[0],
          );
          request.inputArtifacts = [
            {
              name: required(stages[index - 1]),
              backendArtifactId: artifact.artifactId,
              manifestSha256: artifact.manifestSha256,
              mountPath: `/inputs/${stages[index - 1]}`,
              access: 'read',
            },
          ];
          resign(request);
        }
        const response = await fetch(`${url}/managed/pods`, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const { podId } = (await response.json()) as { podId: string };
        handles.push({ podId, request });
        const runtimeRef = required(components.service.row('installation', podId).runtime_ref);
        const confinement = await manager.execInContainer(runtimeRef, [
          'python3',
          '-c',
          "import pathlib,socket; s=socket.socket(); s.settimeout(0.3); assert s.connect_ex(('1.1.1.1',443)) != 0; assert int(next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),16)==0",
        ]);
        expect(confinement.exitCode).toBe(0);
        if (index < 2) {
          const write = await manager.execInContainer(runtimeRef, [
            'sh',
            '-c',
            'echo forbidden >> /repositories/fixture-repo/README.md',
          ]);
          expect(write.exitCode).not.toBe(0);
        }
        if (index) {
          const write = await manager.execInContainer(runtimeRef, [
            'sh',
            '-c',
            `echo forbidden >> /inputs/${stages[index - 1]}/${stages[index - 1]}.md`,
          ]);
          expect(write.exitCode).not.toBe(0);
        }

        const deadline = Date.now() + 480000;
        while (true) {
          const row = components.service.row('installation', podId);
          if (['failed', 'killed', 'review_required'].includes(row.state))
            throw new Error(`stage-${stages[index]}-${row.state}`);
          if (row.state === (index === 2 ? 'validated' : 'complete')) break;
          if (Date.now() >= deadline) throw new Error(`stage-${stages[index]}-timeout`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const result = components.controls.observe('installation', podId, '0').result;
        expect(result.artifacts).toHaveLength(1);
        const mounted = required(components.service.inputs).mounts(podId);
        if (index) expect(required(mounted[0]).readOnly).toBe(true);
        const row = components.service.row('installation', podId);
        const output = await manager.execInContainer(required(row.runtime_ref), [
          'cat',
          `/output/${stages[index]}.md`,
        ]);
        expect(output.stdout).toContain(nonce);
        receipts.push({
          stage: stages[index],
          podId,
          inputArtifacts: request.inputArtifacts,
          result,
          report: output.stdout,
        });
      }
      const last = required(handles[2]);
      const candidate = required(components.service.source).candidate('installation', last.podId);
      const checkout = path.join(root, 'independent');
      const bundle = path.join(root, 'candidate.bundle');
      writeFileSync(bundle, candidate.bundle);
      git(root, 'clone', bundle, checkout);
      git(checkout, 'checkout', '--detach', candidate.receipt.newCommit);
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict'; import { normalizeTitle } from './canary-normalize.mjs'; assert.equal(normalizeTitle('  hello  '), 'hello'); assert.equal(normalizeTitle(' a b '), 'a b'); for (const x of ['', '   ', null, undefined, 12, [], {}]) assert.throws(() => normalizeTitle(x), TypeError);`,
        ],
        { cwd: checkout, stdio: 'pipe' },
      );
      expect(git(remote, 'rev-parse', 'main')).toBe(base);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      for (const { podId } of handles) {
        const ref = components.service.row('installation', podId).runtime_ref;
        if (!ref) continue;
        try {
          const log = await manager.execInContainer(
            ref,
            [
              'python3',
              '-c',
              "import pathlib; files=list(pathlib.Path('/tmp').glob('managed-codex-*/codex.jsonl')); print(files[0].read_text()[-8000:] if files else 'worker-log-unavailable')",
            ],
            { timeout: 5000 },
          );
          diagnostics.push({ podId, log: log.stdout });
          const state = await manager.execInContainer(
            ref,
            [
              'python3',
              '-c',
              "import pathlib,json; root=next(pathlib.Path('/run').glob('dispatcher-managed-*')); print(json.dumps({name:(root/name).read_text()[-8000:] for name in ['execution.json','channel-failure.json','stderr'] if (root/name).exists()}))",
            ],
            { user: 'root', timeout: 5000 },
          );
          diagnostics.push({ podId, supervisor: state.stdout });
        } catch {
          diagnostics.push({ podId, unavailable: true });
        }
      }
      throw error;
    } finally {
      if (process.env.AUTOPOD_MANAGED_LIVE_REPORT)
        writeFileSync(
          process.env.AUTOPOD_MANAGED_LIVE_REPORT,
          JSON.stringify(
            {
              verdict: failure ? 'fail' : 'pass',
              failure,
              base,
              model,
              image,
              providerRequests,
              diagnostics,
              receipts,
              observations: handles.map((h) =>
                components.controls.observe('installation', h.podId, '0'),
              ),
              evidenceLevel:
                'real-Docker-real-model-fixture-HTTP-auth-local-candidate-independent-oracle',
              notRun: [
                'Entra login',
                'hosted Azure deployment',
                'GitHub source publication',
                'Dispatcher workflow scheduler',
                'microphone/voice',
              ],
            },
            null,
            2,
          ),
        );
      for (const { podId } of handles) {
        const ref = components.service.row('installation', podId).runtime_ref;
        if (ref) await components.runtime.stop(ref).catch(() => {});
        await docker
          .getContainer(`autopod-${podId}`)
          .remove({ force: true })
          .catch(() => {});
        await network.removeNetworkForPod(podId);
      }
      await app.close();
      components.close();
      f.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  1500000,
);
