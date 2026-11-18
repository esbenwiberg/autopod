import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import type {
  CombinedPolicy,
  Role,
  SignedGateReceipt,
} from '../orchestration/combined-attestation.js';
import type { GateSelection } from '../orchestration/combined-checkpoint.js';
import { startFixtureProcess } from './owned-fixture-process.js';

export async function ownedEvaluator(
  bundle: string,
  root: string,
  role: Role,
  database: string,
  run: string,
) {
  const dir = path.join(root, role);
  await mkdir(path.join(dir, 'tmp'), { recursive: true });
  const p = startFixtureProcess<{ type: 'ready'; pid: number; authority: CombinedPolicy[Role] }>(
    bundle,
    [role, database, path.join(root, 'merge.bundle'), run],
    dir,
  );
  onTestFinished(() => p.dispose());
  const { pid, authority } = await p.message;
  assert.equal(pid, p.child.pid);
  let cached: { key: string; receipt: SignedGateReceipt } | undefined;
  async function evaluate(selection: GateSelection) {
    const key = digest(selection);
    if (cached) {
      assert.equal(cached.key, key);
      return cached.receipt;
    }
    p.child.send(selection);
    const exit = await p.exit;
    if (exit.code !== 0 || exit.signal !== null) throw new Error('evaluator-input-rejected');
    const receipt = JSON.parse(
      await readFile(path.join(dir, 'receipt.json'), 'utf8'),
    ) as SignedGateReceipt;
    cached = { key, receipt };
    return receipt;
  }
  return { pid, authority, evaluate };
}
