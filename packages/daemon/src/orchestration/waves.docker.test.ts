import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { expect, it } from 'vitest';
import { buildStartupHarness } from '../test-utils/build-startup-harness.js';
import { resign } from '../test-utils/managed-fixture.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { startFixtureProcess } from '../test-utils/owned-fixture-process.js';

const image = process.env.AUTOPOD_WAVE_DOCKER_IMAGE;
const liveModel = process.env.AUTOPOD_WAVE_LOCAL_MODEL === '1';
it.skipIf(!image && !liveModel)(
  'keeps three original Docker IDs through scheduler SIGKILL, starts only two follow-ups, then stops all five',
  async () => {
    const socket = process.env.AUTOPOD_MANAGED_DOCKER_SOCKET;
    if (!socket || !path.isAbsolute(socket) || !image || !/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('explicit local socket and immutable local image ID required');
    const docker = new Docker({ socketPath: socket, timeout: 15000 });
    expect((await docker.getImage(image).inspect()).Id).toBe(image);
    const { f, root, request, cp, ledger } = await setupOrchestrationRun(18, 6);
    request.outputs.artifacts.mode = 'required';
    request.outputs.artifacts.requiredPaths = ['report.md'];
    await ledger().kickoff(cp, { inspect: resign(request) });
    const owner = randomUUID();
    const label = 'autopod.orchestration.canary';
    const list = () =>
      docker.listContainers({ all: true, filters: { label: [`${label}=${owner}`] } });
    // List only for ownership discovery. List summaries can lag a completed wait;
    // inspect each immutable ID for the runtime state used by the assertion.
    const active = async () => {
      const states = await Promise.all(
        (await list()).map((c) => docker.getContainer(c.Id).inspect()),
      );
      return states
        .filter((c) => c.State.Running)
        .map((c) => c.Id)
        .sort();
    };
    const calls = async () => (await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n');
    await mkdir(path.join(root, 'tmp'), { recursive: true });
    const script = await buildStartupHarness('docker-wave-scheduler');
    const start = (mode: string) =>
      startFixtureProcess<{ type: 'ready'; pid: number }>(
        script,
        [f.db.name, root, socket, image, owner, mode, liveModel ? 'local-model' : 'offline'],
        root,
        90000,
      );
    const children: ReturnType<typeof start>[] = [];
    try {
      const first = start('first');
      children.push(first);
      const ready = await first.message;
      expect(ready.pid).toBe(first.child.pid);
      const original = await active();
      expect(original).toHaveLength(6);
      expect(await calls()).toEqual([String(ready.pid)]);
      const decision = (kickoff: boolean) =>
        JSON.parse(
          f.db
            .prepare(
              "SELECT decision_json FROM orchestration_controller_turns WHERE (wait_key='@kickoff')=?",
            )
            .pluck()
            .get(Number(kickoff)) as string,
        ) as { children: { brief: string }[]; waitFor: number | null };
      expect(decision(true).waitFor).toBe(3);
      const reports = [
        'MAPLE: The ticket total double-counts the first entry.',
        'CEDAR: Display formatting passes every check; no defect.',
        'IRIS: The archive export omits the final row.',
      ];
      const survivors = original.slice(3);
      for (const [i, id] of original.slice(0, 3).entries()) {
        // FIFO release, not a sleep or simulated exit. Docker wait observes normal completion.
        await promisify(execFile)(
          'docker',
          [
            '--host',
            `unix://${socket}`,
            'exec',
            id,
            '/bin/sh',
            '-ec',
            'test -p /tmp/finish && printf "%s\\n" "$1" > /tmp/finish',
            'release',
            liveModel ? reports[i]! : 'finish',
          ],
          { env: { PATH: process.env.PATH, HOME: root }, timeout: 10000 },
        );
        expect((await docker.getContainer(id).wait()).StatusCode).toBe(0);
      }
      expect(await active()).toEqual(survivors);
      let diagnostic = '';
      first.child.stderr?.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-3000);
      });
      first.child.send('collect');
      const termination = await first.exit;
      expect(termination, diagnostic).toEqual({ code: null, signal: 'SIGKILL' });
      first.assertHealthy();
      f.restart();
      expect(await active()).toEqual(survivors);
      expect(await list()).toHaveLength(6);
      expect(
        f.db
          .prepare("SELECT count(*) FROM orchestration_controller_turns WHERE status='decided'")
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        f.db
          .prepare('SELECT count(*) FROM orchestration_continuations WHERE pod_id IS NULL')
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get(),
      ).toBe(0);
      if (liveModel) {
        const plan = decision(false);
        expect(plan.waitFor).toBeNull();
        expect(plan.children).toHaveLength(2);
        const briefs = plan.children.map((c) => c.brief);
        expect(
          briefs.filter(
            (b) => /\bMAPLE\b/i.test(b) && /double|count|total/i.test(b) && !/IRIS|CEDAR/i.test(b),
          ),
        ).toHaveLength(1);
        expect(
          briefs.filter(
            (b) =>
              /\bIRIS\b/i.test(b) && /archive|export|final row/i.test(b) && !/MAPLE|CEDAR/i.test(b),
          ),
        ).toHaveLength(1);
      }
      const second = start('recover');
      children.push(second);
      const recovered = await second.message;
      expect(recovered.pid).not.toBe(ready.pid);
      const live = await active();
      expect(live).toHaveLength(5);
      expect(live.filter((id) => original.includes(id))).toEqual(survivors);
      expect(await list()).toHaveLength(8);
      expect(
        f.db
          .prepare(
            'SELECT count(*),count(DISTINCT pod_id),sum(reserved_requests) FROM orchestration_continuations',
          )
          .raw()
          .get(),
      ).toEqual([8, 8, 16]);
      expect(
        (
          f.db
            .prepare('SELECT runtime_ref FROM managed_pods WHERE observed_exit=0')
            .pluck()
            .all() as string[]
        ).sort(),
      ).toEqual(live);
      expect(await calls()).toEqual([String(ready.pid), String(ready.pid)]);
      second.child.send('cancel');
      expect(await second.exit).toEqual({ code: 0, signal: null });
      second.assertHealthy();
      expect(await active()).toEqual([]);
      expect(await list()).toHaveLength(8);
      expect(
        f.db
          .prepare("SELECT count(*) FROM managed_pods WHERE observed_exit=1 AND state='killed'")
          .pluck()
          .get(),
      ).toBe(5);
      expect(
        f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get(),
      ).toBe(0);
    } finally {
      if (liveModel) {
        for (const phase of ['kickoff', 'results']) {
          const reply = await readFile(path.join(root, 'reply-' + phase), 'utf8').catch(() => null);
          console.info('local model ' + phase + ': ' + (reply ?? 'no recorded reply'));
        }
        console.info(
          'attempts:',
          (await calls().catch(() => [])).length,
          'containers:',
          (await list()).length,
        );
      }
      await Promise.all(children.map((p) => p.dispose()));
      for (const info of await list()) {
        expect(info.Labels[label]).toBe(owner);
        await docker.getContainer(info.Id).remove({ force: true, v: true });
      }
      expect(await list()).toEqual([]);
    }
  },
  120000,
);
