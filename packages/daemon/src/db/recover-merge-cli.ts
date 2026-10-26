import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  type MergeRecoveryEvidence,
  recoverUncertainMerge,
} from '../pods/merge-operator-recovery.js';
import { createPodRepository } from '../pods/pod-repository.js';

// Deliberately operator-only: never invoked by approval, polling, or a coding worker.
const args = process.argv.slice(2);
function value(flag: string): string {
  const index = args.indexOf(flag);
  const result = index >= 0 ? args[index + 1] : undefined;
  if (!result || result.startsWith('--')) throw new Error(`Required: ${flag}`);
  return result;
}
async function main() {
  const apply = args.includes('--apply');
  if (apply && !args.includes('--accept-unknown-original-outcome')) {
    throw new Error(
      'Apply requires --accept-unknown-original-outcome; open PR status alone does not prove rejection.',
    );
  }
  const db = new Database(value('--db'));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const podId = value('--pod');
    const pod = createPodRepository(db).getOrThrow(podId);
    if (!pod.worktreePath) throw new Error('Retained worktree unavailable');
    const git = (...command: string[]) =>
      execFileSync('git', ['-C', pod.worktreePath ?? '', ...command], { encoding: 'utf8' }).trim();
    const evidence = JSON.parse(readFileSync(value('--evidence'), 'utf8')) as MergeRecoveryEvidence;
    const input = {
      podId,
      attemptId: value('--attempt'),
      headSha: value('--head'),
      actor: value('--actor'),
      reason: value('--reason'),
      evidence,
      local: {
        branch: git('symbolic-ref', '--short', 'HEAD'),
        headSha: git('rev-parse', 'HEAD'),
        clean: git('status', '--porcelain', '--untracked-files=normal') === '',
      },
    };
    console.log(JSON.stringify(recoverUncertainMerge(db, input, false)));
    if (apply) {
      const backup = value('--backup');
      await db.backup(backup);
      console.log(JSON.stringify({ backup, ...recoverUncertainMerge(db, input, true) }));
    }
  } finally {
    db.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
