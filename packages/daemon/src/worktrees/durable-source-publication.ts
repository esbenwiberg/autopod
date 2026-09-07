import { AutopodError, type Pod } from '@autopod/shared';
import type {
  BranchPublicationOptions,
  BranchPublicationReceipt,
  WorktreeManager,
} from '../interfaces/worktree-manager.js';
import type { SourcePublicationLedger } from '../pods/source-publication-ledger.js';

function repositoryIdentity(raw: string): string {
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : raw);
  return `${url.protocol === 'file:' ? 'file:' : ''}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
}
export async function publishSource(
  ledger: SourcePublicationLedger,
  pod: Pod,
  expectedRepository: string,
  manager: WorktreeManager,
  options?: Omit<BranchPublicationOptions, 'onPrepared'>,
): Promise<BranchPublicationReceipt> {
  let intentId: string | undefined;
  const failure = () =>
    new AutopodError(
      'Source publication requires durable reconciliation; original resources must be retained.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
  if (!pod.worktreePath || !pod.branch) throw failure();
  const receipt = await manager.pushBranch(pod.worktreePath, pod.branch, {
    ...options,
    expectedRepository,
    onPrepared(source) {
      if (repositoryIdentity(source.repository) !== repositoryIdentity(expectedRepository))
        throw failure();
      intentId = ledger.admit(pod, source);
    },
  });
  if (!intentId || !receipt) throw failure();
  ledger.confirm(pod, intentId, receipt);
  return receipt;
}
