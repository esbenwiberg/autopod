import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import pino from 'pino';
import { expect, it } from 'vitest';
import { filesRoutes } from '../api/routes/files.js';
import type { SandboxApiClient } from '../containers/sandbox-api-client.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import type { PodManager } from './pod-manager.js';

const run = promisify(execFile);

it('preserves a repo-backed dependency workspace and collects native output before dependent work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-sandbox-handoff-'));
  const workspace = path.join(root, 'workspace');
  let requests = 0;
  const request = async () => {
    requests++;
    // Model data-plane round trips, rather than slow local filesystem copies.
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const localPath = (name: string) =>
    name === '/workspace' || name.startsWith('/workspace/')
      ? path.join(workspace, name.slice('/workspace'.length))
      : name;
  const client = {
    async exec(_id: string, command: string[]) {
      await request();
      try {
        const executable = command[0];
        if (!executable) throw new Error('Empty sandbox command');
        const result = await run(executable, command.slice(1).map(localPath));
        return { ...result, exitCode: 0 };
      } catch (error) {
        const result = error as { stdout: string; stderr: string; code: number };
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
      }
    },
    async readFile(_id: string, name: string) {
      await request();
      return readFile(localPath(name));
    },
    async listFiles(_id: string, name: string) {
      await request();
      return {
        path: name,
        entries: await Promise.all(
          (await readdir(localPath(name))).map(async (entry) => {
            const info = await stat(localPath(path.posix.join(name, entry)));
            return {
              name: entry,
              path: path.posix.join(name, entry),
              isDirectory: info.isDirectory(),
              size: info.size,
            };
          }),
        ),
      };
    },
  } as unknown as SandboxApiClient;
  const manager = new SandboxContainerManager(client, pino({ level: 'silent' }));
  let copying: Promise<void> | undefined;
  const extract = manager.extractDirectoryFromContainer.bind(manager);
  manager.extractDirectoryFromContainer = (...args) => {
    copying = extract(...args);
    return copying;
  };
  const app = Fastify();
  try {
    await mkdir(workspace);
    // Real AutoPod source tree and installed dependency files, plus a research worktree copy.
    await cp(path.resolve('src'), path.join(workspace, 'src'), { recursive: true });
    await cp(path.resolve('package.json'), path.join(workspace, 'package.json'));
    await run('git', ['init', '--quiet', workspace]);
    await run('git', ['-C', workspace, 'add', 'src', 'package.json']);
    await mkdir(path.join(workspace, 'node_modules'), { recursive: true });
    await cp(
      path.resolve('node_modules/typescript/lib'),
      path.join(workspace, 'node_modules/typescript/lib'),
      { recursive: true },
    );
    await cp(path.join(workspace, 'src'), path.join(workspace, '.claude/worktrees/benchmark/src'), {
      recursive: true,
    });
    await mkdir(path.join(workspace, 'dispatcher-output'));
    const published = new Map<string, string>();
    filesRoutes(app, {
      getSession: (id: string) => ({
        status: published.has(id) ? 'complete' : 'running',
        options: { output: 'artifact' },
        artifactsPath: published.get(id) ?? null,
        worktreePath: null,
        containerId: null,
        executionTarget: 'sandbox',
      }),
    } as unknown as PodManager);
    let input = '# Research\nRepository-backed benchmark findings.\n';
    const stages: string[] = [];
    const inventories: Array<{ stage: string; entries: number; bytes: number }> = [];
    const started = Date.now();
    for (const stage of ['research', 'plan', 'implement']) {
      const requestsBeforeStage = requests;
      // A local worker writes its native output file. A dependent worker receives
      // only the preceding stage's completed-state HTTP file-content response.
      const output = stage === 'research' ? input : `# ${stage} derived from:\n${input}`;
      await writeFile(path.join(workspace, `dispatcher-output/${stage}.md`), output);
      const snapshot = await collectArtifactSnapshot({
        containerManager: manager,
        containerId: 'isolated-local-sandbox',
        artifactRoot: path.join(root, 'artifacts', stage),
        generation: 1,
        cycle: 1,
        isCurrent: () => true,
      });
      // Bound network fan-out independently of filesystem/gzip/CI speed.
      expect(requests - requestsBeforeStage).toBeLessThan(30);
      // This local driver opens the completed-state gate only after preservation.
      // It does not run Dispatcher scheduling or the full pod-manager lifecycle.
      published.set(stage, snapshot);
      const receipt = JSON.parse(await readFile(`${snapshot}.receipt.json`, 'utf8'));
      inventories.push({ stage, entries: receipt.entries, bytes: receipt.bytes });
      expect(
        (await readFile(path.join(snapshot, 'node_modules/typescript/lib/typescript.js'))).equals(
          await readFile(path.join(workspace, 'node_modules/typescript/lib/typescript.js')),
        ),
      ).toBe(true);
      expect(
        (
          await readFile(
            path.join(snapshot, '.claude/worktrees/benchmark/src/pods/artifact-preservation.ts'),
          )
        ).equals(await readFile(path.join(workspace, 'src/pods/artifact-preservation.ts'))),
      ).toBe(true);
      const response = await app.inject({
        method: 'GET',
        url: `/pods/${stage}/files/content?path=dispatcher-output/${stage}.md`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().content).toBe(output);
      input = response.json().content;
      stages.push(stage);
    }
    expect(stages).toEqual(['research', 'plan', 'implement']);
    expect(input).toContain('Repository-backed benchmark findings.');
    expect(requests).toBeLessThan(90);
    process.stdout.write(
      `${JSON.stringify({ proof: 'local sandbox adapter + Fastify dependent file collection', requests, elapsedMs: Date.now() - started, stages, inventories })}\n`,
    );
  } finally {
    await app.close();
    // An expired collector retains ownership of staging until its real copy settles.
    await copying?.catch(() => {});
    process.stdout.write(`${JSON.stringify({ proof: 'export request count', requests })}\n`);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
