// Fixed synthetic workload only; never execute a model brief or use a profile repository.
import assert from 'node:assert/strict';
import { chmod, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService, type ManagedRuntimePort } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';

export const canaryLabel = 'autopod.orchestration.canary';
export function dockerCanaryService(
  db: Database.Database,
  root: string,
  docker: Docker,
  image: string,
  owner: string,
  profile: ManagedPodRequest['profileSnapshot'],
  syntheticReports = false,
) {
  const label = canaryLabel;
  const owned = async (ref: string) => {
    const c = docker.getContainer(ref);
    const info = await c.inspect();
    assert.equal(info.Config.Labels[label], owner);
    return { c, info };
  };
  const compose = (mirror?: string) => {
    const runtime: ManagedRuntimePort = {
      async preflight() {
        assert.equal((await docker.getImage(image).inspect()).Id, image);
      },
      async ensure(id, spec, checkpoint) {
        assert(mirror && /^managed-[0-9a-f-]+$/.test(id));
        const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
        assert(pin);
        const source = path.join(root, id),
          output = path.join(root, 'output', id);
        await managedGit(root, ['clone', '--no-local', '--no-checkout', mirror, source]);
        await managedGit(source, ['checkout', '--detach', pin]);
        await mkdir(output, { recursive: true });
        await chmod(output, 0o777);
        const c = await docker.createContainer({
          name: `ap-wave-${owner}-${id}`,
          Image: image,
          Labels: { [label]: owner, 'autopod.canary.pod': id },
          User: '65534:65534',
          // Fail-safe lifetime even if the test driver itself is interrupted.
          Entrypoint: ['/bin/busybox', 'timeout', '-s', 'KILL', '120', '/bin/sh'],
          Cmd: [
            '-ec',
            `test "$(cat /src/.git/HEAD)" = "$1"; test "$(cat /src/proof.txt)" = 'unpublished checkpoint'; mkfifo /tmp/finish; read -r result </tmp/finish; if test "$2" = reports; then printf '%s\\n' "$result" > /out/report.md; else test "$result" = finish; printf 'Checked pinned fixture\\n' > /out/report.md; fi`,
            'worker',
            pin,
            syntheticReports ? 'reports' : 'checkpoint',
          ],
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: 24,
            Memory: 32 * 1024 * 1024,
            NanoCpus: 250000000,
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=1m' },
            Binds: [`${source}:/src:ro`, `${output}:/out:rw`],
          },
        });
        checkpoint(c.id);
        await c.start();
        return { runtimeRef: c.id };
      },
      async observe(ref) {
        const { info } = await owned(ref);
        return {
          state: info.State.Running
            ? 'running'
            : ['exited', 'dead'].includes(info.State.Status)
              ? 'stopped'
              : 'unknown',
          exitCode: info.State.ExitCode,
          consumedTokens: 0,
        };
      },
      async stop(ref) {
        const { c, info } = await owned(ref);
        if (info.State.Running) await c.kill();
      },
      async extractOutput(ref, staging) {
        const { info } = await owned(ref);
        assert(!info.State.Running && info.State.ExitCode === 0);
        const id = info.Config.Labels['autopod.canary.pod'];
        assert(/^managed-[0-9a-f-]+$/.test(id));
        await cp(path.join(root, 'output', id), staging, { recursive: true });
      },
    };
    const s = new ManagedPodService(
      db,
      {
        profiles: new Map([[profile.snapshotDigest, profile]]),
        enrollmentCeiling: profile.scope,
        identityCeiling: profile.scope,
        backendCeiling: profile.scope,
        enforcement: REQUIRED_ENFORCEMENT,
        targets: ['local'],
      },
      runtime,
      () => 100,
      true,
    );
    new ManagedArtifactPipeline(
      s,
      new ArtifactExports(db, new MemoryArtifactStore()),
      path.join(root, 'staging'),
      new ManagedControls(s),
    );
    return s;
  };
  return compose;
}
