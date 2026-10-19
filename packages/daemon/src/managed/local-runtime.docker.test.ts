import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import Fastify from 'fastify';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { DockerNetworkManager } from '../containers/docker-network-manager.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { registerManagedComponentRoutes } from './bootstrap.js';
import { digest } from './canonical.js';
import { createManagedArtifactStore } from './cli-config.js';
import { ContainerCodexChannel, codexReportCommand } from './codex-channel.js';
import { codexSse } from './codex-wire.js';
import { WORKER_WRITABLE } from './container-runtime.js';
import { composeManagedRuntime } from './runtime-composition.js';

const image = process.env.AUTOPOD_MANAGED_DOCKER_IMAGE;
it.skipIf(!image).each(['complete', 'cancel', 'prestart-failure'] as const)(
  'runs an HTTP managed job in Docker: %s, restart and cleanup',
  async (mode) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'autopod-managed-docker-')));
    const f = requestTimeFixture();
    const docker = new Docker({ socketPath: process.env.AUTOPOD_MANAGED_DOCKER_SOCKET });
    const logger = pino({ level: 'silent' });
    const manager = new DockerContainerManager({ docker, logger });
    const network = new DockerNetworkManager({ docker, logger });
    const execute = manager.execInContainer.bind(manager);
    if (mode === 'prestart-failure') {
      vi.spyOn(manager, 'execInContainer').mockImplementation((ref, command, options) =>
        execute(
          ref,
          command[2] === WORKER_WRITABLE
            ? ['python3', '-c', "raise RuntimeError('controlled-preparation-failure')"]
            : command,
          options,
        ),
      );
    }
    const request = f.request;
    const mirror = path.join(root, 'mirror');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(root, 'init', '-b', 'main', mirror);
    git(mirror, 'config', 'user.name', 'Fixture');
    git(mirror, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(mirror, 'README.md'), 'The canary color is turquoise.\n');
    git(mirror, 'add', '.');
    git(mirror, 'commit', '-m', 'fixture');
    const base = git(mirror, 'rev-parse', 'HEAD');
    for (const owner of [request.profileSnapshot, request.effectiveGrant]) {
      owner.scope.repositories[0]!.baseRevision = base;
      owner.budget.expiresAt = Math.floor(Date.now() / 1000) + 180;
    }
    request.profileSnapshot.snapshotDigest = digest(
      Object.fromEntries(
        Object.entries(request.profileSnapshot).filter(([k]) => k !== 'snapshotDigest'),
      ),
    );
    request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
    request.outputs.artifacts.requiredPaths = ['report.md'];
    request.outputs.artifacts.include = ['report.md'];
    request.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 16384, maxTotalBytes: 16384 };
    resign(request);
    const cli = { bindings: [], artifactDirectory: path.join(root, 'artifacts') };
    let store = createManagedArtifactStore(cli, f.db);
    let calls = 0;
    let cleanupAttempts = 0;
    const config = {
      db: f.db,
      enabled: true,
      store,
      stateRoot: path.join(root, 'state'),
      admission: {
        ...f.admission,
        profiles: new Map([[request.profileSnapshot.snapshotDigest, request.profileSnapshot]]),
      },
      mirrors: [
        {
          enrollmentId: 'fixture-repo',
          path: mirror,
          remote: 'fixture-remote',
          baseRevision: base,
        },
      ],
      bindings: [
        {
          route: request.route,
          manager,
          image: image!,
          command: codexReportCommand(request.route, 'fixture-repo'),
          transport: {
            budgetMode: 'request-time' as const,
            bindingDigest: 'controlled-docker-provider',
            maximumPromptBytes: 128 * 1024,
            maximumResponseBytes: 2 * 1024 * 1024,
            preflight() {},
            async generate(_route: unknown, prompt: string, _maximum: number, signal: AbortSignal) {
              calls++;
              expect(prompt).toContain('turquoise');
              if (mode === 'cancel')
                await new Promise((_, reject) => {
                  signal.addEventListener('abort', () => reject(new Error('controlled-abort')), {
                    once: true,
                  });
                });
              return {
                value:
                  (mode === 'complete' ? `:${'x'.repeat(1024 * 1024)}\n\n` : '') +
                  codexSse({
                    model: request.route.model,
                    status: 'completed',
                    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
                    output: [
                      {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'The canary color is turquoise.' }],
                      },
                    ],
                  }),
                consumedTokens: 12,
              };
            },
          },
          channel: new ContainerCodexChannel(manager, request.route, 0),
          maximumRequests: 1,
          network: async (_request: unknown, podId: string) => ({
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
          cleanupNetwork: (podId: string) => {
            if (mode === 'complete' && ++cleanupAttempts === 1)
              throw new Error('controlled-network-cleanup-interruption');
            return network.removeNetworkForPod(podId);
          },
        },
      ],
    };
    let components = composeManagedRuntime(config);
    let app = Fastify();
    const mount = async () => {
      registerManagedComponentRoutes(app, components, { db: f.db, store }, async (r) =>
        r.headers.authorization === 'Bearer fixture-only' ? 'installation' : null,
      );
      return app.listen({ host: '127.0.0.1', port: 0 });
    };
    let url = await mount();
    let podId: string | undefined;
    const headers = { 'content-type': 'application/json', authorization: 'Bearer fixture-only' };
    const control = async (operation: string) =>
      fetch(`${url}/managed/pods/${podId}/control/${operation}-once`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          dispatcherAttemptId: request.dispatcherAttemptId,
          grantId: request.effectiveGrant.grantId,
          grantRevision: 1,
          operation,
        }),
      });
    try {
      expect((await fetch(`${url}/managed/health`)).status).toBe(401);
      const started = await fetch(`${url}/managed/pods`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      if (mode === 'prestart-failure') {
        expect(started.status).not.toBe(200);
        const allocation = components.service.lookup('installation', request.startKey);
        expect(allocation?.runtime_ref).toBeTruthy();
        podId = allocation!.pod_id;
        const ref = allocation!.runtime_ref!;
        expect(calls).toBe(0);
        expect((await control('revoke')).status).toBe(200);
        await expect
          .poll(() => components.service.row('installation', podId!).observed_exit, {
            timeout: 10000,
          })
          .toBe(1);
        expect(
          components.controls.observe('installation', podId, '0').result.limitations,
        ).toContain('managed-worker-never-started');
        const cleaned = await control('cleanup');
        expect(cleaned.status, await cleaned.clone().text()).toBe(200);
        expect(((await cleaned.json()) as { cleanup: string }).cleanup).toBe('observed');
        await expect(docker.getContainer(ref).inspect()).rejects.toMatchObject({ statusCode: 404 });
        await expect(docker.getNetwork(`autopod-${podId}`).inspect()).rejects.toMatchObject({
          statusCode: 404,
        });
        expect(calls).toBe(0);
        return;
      }
      expect(started.status, await started.clone().text()).toBe(200);
      const handle = (await started.json()) as { podId: string };
      podId = handle.podId;
      const row = components.service.row('installation', podId);
      expect(row.runtime_ref).toBeTruthy();
      const isolated = await manager.execInContainer(row.runtime_ref!, [
        'python3',
        '-c',
        "import socket; s=socket.socket(); s.settimeout(0.3); assert s.connect_ex(('1.1.1.1',443)) != 0",
      ]);
      expect(isolated.exitCode).toBe(0);
      const readonly = await manager.execInContainer(row.runtime_ref!, [
        'sh',
        '-c',
        'echo forbidden >> /repositories/fixture-repo/README.md',
      ]);
      expect(readonly.exitCode).not.toBe(0);
      const duplicate = await fetch(`${url}/managed/pods`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      expect(((await duplicate.json()) as { podId: string }).podId).toBe(podId);
      // Capabilities granted to trusted root setup must not reach the worker uid.
      const denied = await manager.execInContainer(row.runtime_ref!, [
        'python3',
        '-c',
        "import pathlib; p=pathlib.Path('/proc/self/status'); print(next(x for x in p.read_text().splitlines() if x.startswith('CapEff:')))",
      ]);
      expect(denied.stdout.trim()).toMatch(/CapEff:\s+0+$/);
      if (mode === 'cancel') {
        await expect.poll(() => calls, { timeout: 10000 }).toBe(1);
        expect((await control('stop')).status).toBe(200);
        await expect
          .poll(() => components.service.row('installation', podId!).observed_exit, {
            timeout: 10000,
          })
          .toBe(1);
        expect(components.service.row('installation', podId!).state).toBe('killed');
        const cleaned = await control('cleanup');
        expect(cleaned.status, await cleaned.clone().text()).toBe(200);
        expect(((await cleaned.json()) as { cleanup: string }).cleanup).toBe('observed');
        await expect(docker.getNetwork(`autopod-${podId}`).inspect()).rejects.toMatchObject({
          statusCode: 404,
        });
        return;
      }
      await expect
        .poll(() => components.service.row('installation', podId!).state, {
          timeout: 60000,
          interval: 500,
        })
        .toBe('complete');
      expect(calls).toBe(1);
      const spool = await manager.execInContainer(row.runtime_ref!, [
        'sh',
        '-c',
        `test -r /run/dispatcher-${podId}/channel-response.json`,
      ]);
      expect(spool.exitCode).not.toBe(0);
      const result = components.controls.observe('installation', podId, '0').result;
      expect(result.artifacts).toHaveLength(1);
      const artifact = result.artifacts[0]!;
      const before = await store.createDownload(artifact.artifactId);
      await app.close();
      components.close();
      f.restart();
      store = createManagedArtifactStore(cli, f.db);
      components = composeManagedRuntime({ ...config, db: f.db, store });
      await components.resume();
      app = Fastify();
      url = await mount();
      expect((await store.createDownload(artifact.artifactId)).bytes).toEqual(before.bytes);
      const download = await fetch(`${url}/artifacts/${artifact.artifactId}/download`, {
        method: 'POST',
        headers: { authorization: headers.authorization },
      });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(before.bytes);
      expect((await fetch(`${url}/artifacts/${artifact.artifactId}/manifest`)).status).toBe(404);
      expect((await fetch(`${url}/managed/pods/${podId}/events`, { headers })).status).toBe(200);
      expect((await control('cleanup')).status).toBe(409);
      const cleaned = await control('cleanup');
      expect(cleaned.status, await cleaned.clone().text()).toBe(200);
      expect(((await cleaned.json()) as { cleanup: string }).cleanup).toBe('observed');
      expect((await control('cleanup')).status).toBe(200);
      await expect(docker.getNetwork(`autopod-${podId}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(calls).toBe(1);
    } finally {
      await app.close();
      components.close();
      if (podId) {
        await docker
          .getContainer(`autopod-${podId}`)
          .remove({ force: true })
          .catch(() => {});
        await network.removeNetworkForPod(podId);
      }
      f.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
