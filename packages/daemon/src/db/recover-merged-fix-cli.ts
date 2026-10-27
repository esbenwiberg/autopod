import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { MergeRecoveryEvidence } from '../pods/merge-operator-recovery.js';
import { recoverMergedFix } from '../pods/merged-fix-recovery.js';

// Explicit operator recovery only. This CLI never contacts or mutates the provider.
const args = process.argv.slice(2);
function value(flag: string): string {
  const index = args.indexOf(flag);
  const result = index >= 0 ? args[index + 1] : undefined;
  if (!result || result.startsWith('--')) throw new Error(`Required: ${flag}`);
  return result;
}
async function main() {
  const apply = args.includes('--apply');
  if (apply && !args.includes('--accept-merged-fix-source'))
    throw new Error(
      'Apply requires --accept-merged-fix-source; the operator must verify the merged fix delivers this task.',
    );
  const db = new Database(value('--db'));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const sourcePath = resolve(value('--source'));
    const git = (...command: string[]) =>
      execFileSync('git', ['-C', sourcePath, ...command], { encoding: 'utf8' }).trim();
    const evidence = JSON.parse(readFileSync(value('--evidence'), 'utf8')) as MergeRecoveryEvidence;
    const branch = git('symbolic-ref', '--short', 'HEAD');
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const clean = git('status', '--porcelain', '--untracked-files=normal') === '';
    if (head !== git('rev-parse', 'HEAD') || branch !== git('symbolic-ref', '--short', 'HEAD'))
      throw new Error('Source changed during inspection');
    const input = {
      podId: value('--pod'),
      fixPodId: value('--fix'),
      actor: value('--actor'),
      reason: value('--reason'),
      sourcePath,
      evidence,
      local: {
        repository: evidence.pr.repository.webUrl,
        branch,
        remoteRef: `refs/heads/${branch}`,
        commitSha: head,
        treeSha: tree,
        worktreeClean: clean,
      },
    };
    console.log(JSON.stringify(recoverMergedFix(db, input, false)));
    if (apply) {
      const backup = value('--backup');
      await db.backup(backup);
      console.log(JSON.stringify({ backup, ...recoverMergedFix(db, input, true) }));
    }
  } finally {
    db.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
