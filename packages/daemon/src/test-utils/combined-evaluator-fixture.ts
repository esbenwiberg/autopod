// Offline, single-use evaluator. No repo-supplied commands, model calls or private key files.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { digest } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES, managedGit } from '../managed/source-git.js';
import { inspectCombinedSource } from '../orchestration/combined-checkpoint.js';
import { fixtureSigner } from './gate-signer.js';

const [role, database, inbox, authorizedRun] = process.argv.slice(2);
assert(
  (role === 'checks' || role === 'independentReview') &&
    database &&
    inbox &&
    authorizedRun &&
    process.send,
);
const rule =
  role === 'checks' ? { files: ['pool-a', 'pool-b'], limit: 10 } : { files: ['pool-b'], limit: 3 };
const signer = fixtureSigner(role, `local-${role.toLowerCase()}`, digest({ version: 1, rule }));
const request = once(process, 'message');
process.send({ type: 'ready', pid: process.pid, authority: signer.authority });
const ref = z
  .object({
    startKey: z.string().min(1).max(200),
    candidateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
try {
  const [message] = await request;
  const { run, commit, inputs } = z
    .object({
      run: z.literal(authorizedRun),
      commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      inputs: z.tuple([ref, ref]),
    })
    .strict()
    .parse(message);
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const binding = db
      .prepare(
        'SELECT repository,accepted_commit AS predecessor,policy_digest AS policyDigest FROM orchestration_runs WHERE id=? AND canceled=0',
      )
      .get(run) as { repository: string; predecessor: string; policyDigest: string } | undefined;
    assert(binding);
    // The fixed private inbox is host-provisioned. Never accept a URL, path, caller verdict
    // or digest-to-sign. Copy the bytes before importing; never run code from the tree.
    assert((await stat(inbox)).size <= MAX_CANDIDATE_BYTES);
    const bytes = await readFile(inbox);
    assert(bytes.length > 0 && bytes.length <= MAX_CANDIDATE_BYTES);
    const file = path.resolve('source.bundle');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const mirror = path.resolve('source.git');
    await managedGit(process.cwd(), [
      'init',
      '--bare',
      `--object-format=${commit.length === 40 ? 'sha1' : 'sha256'}`,
      mirror,
    ]);
    assert.equal(await managedGit(mirror, ['bundle', 'unbundle', file]), `${commit} HEAD`);
    await managedGit(mirror, ['fsck', '--strict', '--no-reflogs', commit]);
    const subject = {
      ...binding,
      run,
      commit,
      tree: await managedGit(mirror, ['rev-parse', `${commit}^{tree}`]),
    };
    const inputDigest = await inspectCombinedSource(db, subject, mirror, inputs);
    const values = [];
    for (const name of rule.files) {
      const value = await managedGit(mirror, ['show', `${commit}:${name}`]);
      assert(/^\d{1,6}$/.test(value));
      values.push(Number(value));
    }
    const receipt = signer.attest({
      inputDigest,
      status: values.reduce((a, b) => a + b, 0) <= rule.limit ? 'passed' : 'failed',
      evidenceDigest: digest({ commit, rule, values }),
    });
    await writeFile('receipt.json', JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } finally {
    db.close();
  }
} catch {
  // No receipt on malformed selector, missing custody, or divergent source.
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
