import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { digest } from '../managed/canonical.js';
import { tryRecoveryClaim } from './local-recovery-claim.js';

it('a colliding allocation cannot mask a report wake, but both still exclude other hosts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claim-slots-')),
    file = path.join(root, 'test.db');
  const db = new Database(file),
    peer = new Database(file);
  const run = 'run',
    plan = '@controller-turn';
  const slot = digest([run, plan]).slice(-2);
  let n = 0;
  while (digest([run, 'worker-' + n]).slice(-2) !== slot) n++;
  const key = 'worker-' + n;
  try {
    const a = tryRecoveryClaim(db, run, key),
      b = tryRecoveryClaim(db, run, plan);
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(tryRecoveryClaim(db, run, plan)).toBeNull();
    expect(tryRecoveryClaim(db, run, key)).toBeNull();
    b!();
    b!();
    expect(tryRecoveryClaim(peer, run, plan)).toBeNull();
    expect(tryRecoveryClaim(peer, run, key)).toBeNull();
    a!();
    const c = tryRecoveryClaim(peer, run, key);
    expect(c).toBeTypeOf('function');
    c!();
  } finally {
    peer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
