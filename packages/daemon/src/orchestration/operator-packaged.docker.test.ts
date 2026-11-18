import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { expect, it } from 'vitest';
import { buildStartupHarness } from '../test-utils/build-startup-harness.js';
import { operatorSeedFixture } from '../test-utils/operator-seed-fixture.js';
import { startFixtureProcess } from '../test-utils/owned-fixture-process.js';

const image = process.env.AUTOPOD_MANAGED_DOCKER_IMAGE,
  socket = process.env.AUTOPOD_MANAGED_DOCKER_SOCKET;
it.skipIf(!image || !socket)(
  'recovers the authenticated HTTP daemon at the third report with five live packaged workers and no duplicate spend',
  async () => {
    if (!image || !socket || !path.isAbsolute(socket) || !/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('immutable-local-image-required');
    const { enrollment, profiles, cli, root, f, run } = await operatorSeedFixture(image),
      docker = new Docker({ socketPath: socket });
    const token = randomUUID(),
      trace = () => readFile(path.join(root, 'trace'), 'utf8');
    // Let this engine select an available private address range. Use eight tiny dedicated
    // bridges instead of consuming eight whole default pool allocations. Never prune.
    const allocation = await docker.createNetwork({
      Name: 'operator-range-' + randomUUID(),
      Driver: 'bridge',
      Internal: true,
    });
    let subnet: string;
    try {
      const info = await allocation.inspect();
      const range = info.IPAM.Config?.[0]?.Subnet;
      if (!range || !/^\d+\.\d+\.\d+\.0\/(?:1[6-9]|2[0-4])$/.test(range))
        throw new Error('fixture-subnet-unavailable');
      subnet = range.split('.').slice(0, 3).join('.');
    } finally {
      await allocation.remove();
    }
    await writeFile(
      path.join(root, 'operator.json'),
      JSON.stringify({ database: f.db.name, token, enrollment, profiles, cli, socket, subnet }),
      { mode: 0o600 },
    );
    await mkdir(path.join(root, 'tmp'), { recursive: true });
    const script = await buildStartupHarness('packaged-operator-daemon');
    await cp(
      new URL('../managed/runtime/', import.meta.url),
      path.join(path.dirname(script), 'runtime'),
      { recursive: true },
    );
    const start = (mode: string) =>
      startFixtureProcess<{ type: 'ready'; url: string; pid: number }>(
        script,
        [root, mode],
        root,
        115000,
      );
    const processes: ReturnType<typeof start>[] = [];
    const rows = () =>
      f.db
        .prepare(
          'SELECT pod_id,runtime_ref,state,observed_exit FROM managed_pods WHERE dispatcher_installation_id=? ORDER BY rowid',
        )
        .all('native.' + run) as {
        pod_id: string;
        runtime_ref: string | null;
        state: string;
        observed_exit: number;
      }[];
    const status = (url: string, op: string) =>
      fetch(url + '/orchestration/runs/inspection/' + op, {
        method: op === 'status' ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token },
      });
    const inspect = async (row: ReturnType<typeof rows>[number]) => {
      if (!row.runtime_ref) throw new Error('missing ref');
      const info = await docker.getContainer(row.runtime_ref).inspect();
      expect(info.Name).toBe('/autopod-' + row.pod_id);
      return info;
    };
    try {
      const first = start('first');
      processes.push(first);
      const { url } = await first.message;
      expect((await fetch(url + '/orchestration/runs/inspection/status')).status).toBe(401);
      const res = await status(url, 'start');
      expect(res.status, await res.text()).toBe(202);
      expect(await first.exit).toEqual({ code: null, signal: 'SIGKILL' });
      first.assertHealthy();
      const original = rows();
      expect(original).toHaveLength(6);
      const liveBefore = (await Promise.all(original.map(inspect))).filter((i) => i.State.Running);
      expect(liveBefore).toHaveLength(6); // managed supervisor remains available for output collection after worker exit
      const workerIdentity = async (row: ReturnType<typeof rows>[number]) => {
        const { stdout } = await promisify(execFile)('docker', [
          '--host',
          'unix://' + socket,
          'exec',
          '-u',
          'root',
          row.runtime_ref!,
          'python3',
          '-c',
          `import json,pathlib,sys
r=json.loads(pathlib.Path('/run/dispatcher-'+sys.argv[1]+'/execution.json').read_text());assert r['state']=='running' and not r['observedExit'];pid=r['pid']; print(str(pid)+':'+pathlib.Path('/proc/'+str(pid)+'/stat').read_text().split(') ')[1].split()[19])`,
          row.pod_id,
        ]);
        return stdout.trim();
      };
      const survivors = original.filter((r) => !r.observed_exit);
      expect(survivors).toHaveLength(3);
      const originalIds = await Promise.all(survivors.map(inspect)),
        workerIds = await Promise.all(survivors.map(workerIdentity));
      expect(
        f.db
          .prepare('SELECT count(*) FROM orchestration_continuations WHERE run_id=?')
          .pluck()
          .get(run),
      ).toBe(8);
      await rm(enrollment.source.bundlePath);
      const next = start('recover');
      processes.push(next);
      const recovered = await next.message;
      const body = await (await status(recovered.url, 'status')).json();
      expect(body).toMatchObject({
        started: true,
        canceled: false,
        acceptedCommit: enrollment.source.commit,
        remainingRequests: 0,
      });
      expect(body.children).toHaveLength(8);
      const all = rows();
      expect(new Set(all.map((r) => r.runtime_ref)).size).toBe(8);
      expect(all.filter((r) => !r.observed_exit)).toHaveLength(5);
      for (const before of originalIds) {
        const after = await docker.getContainer(before.Id).inspect();
        expect(after.State.Running).toBe(true);
        expect(after.State.StartedAt).toBe(before.State.StartedAt);
      }
      expect((await trace()).trim().split('\n').sort()).toEqual(
        [
          'controller kickoff',
          'controller results',
          'kill',
          'worker CEDAR',
          'worker IRIS',
          'worker MAPLE',
        ].sort(),
      );
      expect(await Promise.all(survivors.map(workerIdentity))).toEqual(workerIds);
      expect(
        await Promise.all(all.filter((r) => !r.observed_exit).map(workerIdentity)),
      ).toHaveLength(5);
      const barrier = Promise.withResolvers<void>();
      const watcher = watch(root, () => {
        if (existsSync(path.join(root, 'exits-observed'))) barrier.resolve();
      });
      try {
        expect((await status(recovered.url, 'cleanup')).status).toBe(409);
        expect((await status(recovered.url, 'cancel')).status).toBe(202);
        await Promise.race([
          barrier.promise,
          next.exit.then(() => {
            throw new Error('premature-exit');
          }),
        ]);
      } finally {
        watcher.close();
      }
      for (let i = 0; i < 2; i++) {
        const c = await status(recovered.url, 'cleanup');
        expect(await c.json()).toEqual({ run, cleaned: 8 });
      }
      for (const r of all) {
        await expect(docker.getContainer(r.runtime_ref!).inspect()).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(docker.getNetwork('autopod-' + r.pod_id).inspect()).rejects.toMatchObject({
          statusCode: 404,
        });
      }
      console.info(
        'PACKAGED_EVIDENCE',
        JSON.stringify({
          image,
          run,
          daemonPids: [first.child.pid, next.child.pid],
          ids: all.map((r) => r.runtime_ref),
          survivingContainers: originalIds.map((r) => r.Id),
          survivingWorkerProcesses: workerIds,
          calls: (await trace()).trim().split('\n'),
          remaining: body.remainingRequests,
          verifiedCleanups: 8,
        }),
      );
      next.child.send('close');
      expect(await next.exit).toEqual({ code: 0, signal: null });
      next.assertHealthy();
      expect(rows().every((r) => r.observed_exit)).toBe(true);
    } catch (e) {
      console.error(
        'packaged trace:',
        await trace().catch(() => ''),
        rows().map((r) => [r.state, r.observed_exit]),
        f.db.prepare('SELECT wait_key,status FROM orchestration_controller_turns').all(),
      );
      throw e;
    } finally {
      for (const p of processes) await p.dispose();
      for (const row of rows()) {
        const name = 'autopod-' + row.pod_id;
        const c = docker.getContainer(row.runtime_ref ?? name);
        const info = await c.inspect().catch((e: { statusCode?: number }) => {
          if (e.statusCode !== 404) throw e;
        });
        if (info) {
          expect(info.Name).toBe('/' + name);
          await c.remove({ force: true });
        }
        await docker
          .getNetwork(name)
          .remove()
          .catch((e: { statusCode?: number }) => {
            if (e.statusCode !== 404) throw e;
          });
      }
    }
  },
  250000,
);
