import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { runMigrations } from './migrate.js';
import { reconcileNativeCheckpoint } from './reconcile-native-checkpoint.js';

it.each([151, 158, 163])(
  'reconciles exact checkpoint %s only in a new verified copy',
  async (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'native-reconcile-'));
    const migrationsDir = resolve(import.meta.dirname, 'migrations');
    const legacyDir = resolve(import.meta.dirname, 'fixtures/native-reliability-151-163');
    const input = join(dir, 'input.db');
    const output = join(dir, 'output.db');
    try {
      for (const name of readdirSync(migrationsDir))
        if (Number.parseInt(name, 10) <= 150)
          copyFileSync(join(migrationsDir, name), join(dir, name));
      for (const name of readdirSync(legacyDir))
        if (Number.parseInt(name, 10) <= version)
          copyFileSync(join(legacyDir, name), join(dir, name));
      const db = new Database(input);
      runMigrations(db, dir, logger);
      insertTestProfile(db);
      db.exec(`INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,task_summary)
      VALUES ('retained','test-profile','Keep source','failed','model','codex','branch','operator','preserve summary');
      INSERT INTO completion_decisions(pod_id,decision_id,response,actor,responded_at)
      VALUES ('retained','question','Keep report only','{"type":"human","userId":"operator"}','2026-01-01');`);
      db.close();
      const bytes = readFileSync(input);
      const receipt = await reconcileNativeCheckpoint(input, output, {
        migrationsDir,
        legacyDir,
        logger,
      });
      expect(readFileSync(input)).toEqual(bytes);
      expect(receipt).toMatchObject({
        fromVersion: version,
        toVersion: 176,
        retainedRowsVerified: true,
        inputFreshness: 'unverified',
      });
      const converted = new Database(output, { readonly: true });
      try {
        expect(
          converted
            .prepare("SELECT response FROM completion_decisions WHERE decision_id='question'")
            .get(),
        ).toEqual({ response: 'Keep report only' });
        expect(
          converted.prepare("SELECT task_summary FROM pods WHERE id='retained'").get(),
        ).toEqual({ task_summary: 'preserve summary' });
        expect(
          converted.prepare('SELECT count(*) AS n FROM managed_provider_requests').get(),
        ).toEqual({ n: 0 });
        expect(converted.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(converted.pragma('foreign_key_check')).toEqual([]);
      } finally {
        converted.close();
      }
      const cliOutput = join(dir, 'cli-output.db');
      const cliReceipt = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve(import.meta.dirname, '../../dist/db/reconcile-native-checkpoint-cli.js'),
            '--input',
            input,
            '--output',
            cliOutput,
          ],
          { encoding: 'utf8' },
        ),
      );
      expect(statSync(cliOutput).mode & 0o777).toBe(0o600);
      expect(cliReceipt).toMatchObject({
        status: 'verified-copy',
        fromVersion: version,
        toVersion: 176,
        retainedRowsVerified: true,
        activated: false,
      });
      expect(readFileSync(input)).toEqual(bytes);
      await expect(
        reconcileNativeCheckpoint(input, output, { migrationsDir, legacyDir, logger }),
      ).rejects.toThrow();
      expect(readFileSync(input)).toEqual(bytes);
      await expect(
        reconcileNativeCheckpoint(input, join(dir, 'no-space.db'), {
          migrationsDir,
          legacyDir,
          logger,
          availableBytes: () => 0,
        }),
      ).rejects.toThrow('headroom');
      const raced = join(dir, 'raced-output.db');
      await expect(
        reconcileNativeCheckpoint(input, raced, {
          migrationsDir,
          legacyDir,
          logger,
          availableBytes: () => {
            writeFileSync(raced, 'concurrent output must survive');
            return Number.MAX_SAFE_INTEGER;
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(raced, 'utf8')).toBe('concurrent output must survive');
      expect(readdirSync(dir).filter((name) => name.startsWith('.autopod-reconcile-'))).toEqual([]);
      const changed = new Database(input);
      changed.exec('CREATE TABLE unrelated_data(value TEXT)');
      changed.close();
      await expect(
        reconcileNativeCheckpoint(input, join(dir, 'invalid.db'), {
          migrationsDir,
          legacyDir,
          logger,
        }),
      ).rejects.toThrow('schema');
      writeFileSync(join(dir, 'output-sentinel.db'), 'preserve existing output');
      await expect(
        reconcileNativeCheckpoint(input, join(dir, 'output-sentinel.db'), {
          migrationsDir,
          legacyDir,
          logger,
        }),
      ).rejects.toThrow();
      expect(readFileSync(join(dir, 'output-sentinel.db'), 'utf8')).toBe(
        'preserve existing output',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
