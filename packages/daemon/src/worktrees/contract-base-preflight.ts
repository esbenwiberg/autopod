import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutopodError, type RequiredFact } from '@autopod/shared';
const execFileAsync = promisify(execFile);
import type { ContractBaseEvidence } from '../interfaces/worktree-manager.js';

export async function inspectContractBase(
  worktreePath: string,
  baseBranch: string,
  facts: RequiredFact[],
): Promise<ContractBaseEvidence> {
  const options = { cwd: worktreePath, timeout: 15_000, maxBuffer: 1024 * 1024 };
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${baseBranch}^{commit}`],
    options,
  );
  const baseCommitSha = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(baseCommitSha))
    throw new Error('Actual contract base identity unavailable');
  const artifacts: ContractBaseEvidence['artifacts'] = [];
  for (const fact of facts) {
    const artifactPath = fact.artifact.path.replace(/^\.\//, '').replace(/\/$/, '');
    if (
      !artifactPath ||
      artifactPath.startsWith('/') ||
      artifactPath.startsWith(':') ||
      artifactPath.includes('\\') ||
      [...artifactPath].some((character) => character.charCodeAt(0) < 32) ||
      artifactPath.split('/').some((p) => !p || p === '.' || p === '..')
    ) {
      throw new AutopodError(
        `Contract artifact ${fact.id} must name a literal repository-relative path`,
        'INVALID_CONTRACT_PATH',
        400,
      );
    }
    const tree = await execFileAsync(
      'git',
      ['ls-tree', '-z', '--full-tree', baseCommitSha, '--', artifactPath],
      options,
    );
    const exists = tree.stdout
      .split('\0')
      .some((entry) => entry.slice(entry.indexOf('\t') + 1) === artifactPath);
    artifacts.push({ path: artifactPath, exists });
    if (
      (fact.artifact.change === 'create' && exists) ||
      (['update', 'delete'].includes(fact.artifact.change) && !exists)
    ) {
      throw new AutopodError(
        `Stale contract requires review: ${fact.id} declares ${fact.artifact.change} for ${artifactPath}, which ${exists ? 'already exists' : 'does not exist'} at freshly fetched base ${baseCommitSha}. Reconcile the declaration before dispatch; existing work is not automatic acceptance.`,
        'STALE_CONTRACT',
        409,
      );
    }
  }
  return { baseCommitSha, artifacts };
}
