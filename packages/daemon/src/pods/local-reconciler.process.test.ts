import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { startFixtureProcess } from '../test-utils/owned-fixture-process.js';

// Windows cannot establish the POSIX SIGKILL exit-signal contract asserted here.
describe.skipIf(process.platform === 'win32')(
  'local reconciliation after POSIX process death',
  () => {
    it('retains a pending decision after SIGKILL and two fresh-process reconciliation passes', async () => {
      const daemon = path.resolve(import.meta.dirname, '../..');
      const children: ReturnType<typeof startFixtureProcess>[] = [];
      const failures: unknown[] = [];
      let root: string | undefined;
      let bundleDir: string | undefined;
      try {
        root = await mkdtemp(path.join(tmpdir(), 'autopod-reconcile-crash-'));
        root = await realpath(root);
        const dataRoot = root;
        await Promise.all(
          ['home', 'tmp', 'worktree'].map((name) => mkdir(path.join(dataRoot, name))),
        );
        const sentinel = path.join(root, 'worktree', 'retained-source.txt');
        await writeFile(sentinel, 'Unpublished source must survive reconciliation.\n');
        await mkdir(path.join(daemon, '.turbo'), { recursive: true });
        bundleDir = await mkdtemp(path.join(daemon, '.turbo', 'reconcile-process-'));
        const bundle = path.join(bundleDir, 'fixture.mjs');
        await build({
          entryPoints: [path.join(daemon, 'src/test-utils/local-reconciler-process-fixture.ts')],
          outfile: bundle,
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node22',
          packages: 'external',
        });
        const filename = path.join(root, 'autopod.db');
        const migrations = path.join(daemon, 'src/db/migrations');
        const isolation = { home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), cwd: root };
        const writer = startFixtureProcess(bundle, ['write', filename, migrations, root], root);
        children.push(writer);
        const ready = await writer.message;
        expect(ready.type).toBe('ready');
        if (ready.type !== 'ready') throw new Error('Expected writer ready barrier');
        expect(ready.pid).toBe(writer.child.pid);
        expect(ready.pid).not.toBe(process.pid);
        expect(ready.isolation).toEqual(isolation);
        expect(ready.open).toBe(true);
        expect(ready.inTransaction).toBe(false);
        expect(ready.snapshot).toMatchObject({
          status: 'awaiting_input',
          generation: 1,
          branch: 'fixture/retained-decision',
          startCommitSha: 'a'.repeat(40),
          worktreePath: path.join(root, 'worktree'),
          containerId: 'fixture-container',
          pendingEscalation: {
            id: 'decision',
            podId: 'settled',
            type: 'ask_human',
            payload: { question: 'Select findings' },
          },
          journal: {
            phase: 'awaiting_human',
            result: 'Report collected',
            pendingDecisionId: 'decision',
            agentSettledAt: expect.any(String),
            sourcePreservedAt: expect.any(String),
          },
          escalations: [
            {
              id: 'decision',
              pod_id: 'settled',
              payload: JSON.stringify({ question: 'Select findings' }),
              response: null,
              resolved_at: null,
            },
          ],
          decisions: [],
          agentRuns: [],
          cleanupIntents: [],
        });
        writer.assertHealthy();
        expect(writer.child.exitCode).toBeNull();
        expect(writer.child.signalCode).toBeNull();
        expect(writer.child.kill('SIGKILL')).toBe(true);
        expect(await writer.exit).toEqual({ code: null, signal: 'SIGKILL' });
        writer.assertHealthy();

        const reader = startFixtureProcess(bundle, ['recover', filename, migrations, root], root);
        children.push(reader);
        const recovered = await reader.message;
        expect(recovered.type).toBe('recovered');
        if (recovered.type !== 'recovered') throw new Error('Expected recovery report');
        expect(recovered.pid).toBe(reader.child.pid);
        expect(recovered.pid).not.toBe(ready.pid);
        expect(recovered.pid).not.toBe(process.pid);
        expect(recovered.isolation).toEqual(isolation);
        expect(recovered.before).toEqual(ready.snapshot);
        expect(recovered.passes).toHaveLength(2);
        for (const pass of recovered.passes) {
          expect(pass.result).toEqual({ recovered: [], killed: [], skipped: ['settled'] });
          expect(pass.snapshot).toEqual(ready.snapshot);
          expect(pass.lastRecoveryTrigger).toBe('restart');
          expect(pass.lastCorrectionMessage).toBe(
            'Human decision remains pending after daemon restart. Review the pending question; preserved worker state may require recovery before continuation.',
          );
        }
        expect(recovered.afterDuplicate).toEqual(ready.snapshot);
        expect(recovered.effects).toEqual([]);
        expect(recovered.integrity).toBe('ok');
        expect(recovered.foreignKeys).toEqual([]);
        expect(recovered.open).toBe(false);
        expect(await reader.exit).toEqual({ code: 0, signal: null });
        reader.assertHealthy();
        expect(await readFile(sentinel, 'utf8')).toBe(
          'Unpublished source must survive reconciliation.\n',
        );
      } catch (error) {
        failures.push(error);
      } finally {
        // Never delete SQLite/worktree files while an owned process might still use them.
        const disposed = await Promise.allSettled(children.map((child) => child.dispose()));
        const failed = disposed.filter((result) => result.status === 'rejected');
        for (const result of failed) failures.push(result.reason);
        if (failed.length === 0) {
          if (root) await rm(root, { recursive: true, force: true });
          if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Process-crash proof failed');
      expect(children).toHaveLength(2);
      expect(root && existsSync(root)).toBe(false);
      expect(bundleDir && existsSync(bundleDir)).toBe(false);
    }, 60_000);
  },
);
