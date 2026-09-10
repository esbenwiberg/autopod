import { AutopodError, type Pod } from '@autopod/shared';
import type {
  BranchPublicationOptions,
  BranchPublicationReceipt,
  MergeBranchConfig,
  WorktreeManager,
} from '../interfaces/worktree-manager.js';
import type { SourcePublicationLedger } from '../pods/source-publication-ledger.js';

export interface ConfirmedSourcePublication extends BranchPublicationReceipt {
  publicationId: string;
}

function repositoryIdentity(raw: string): string {
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : raw);
  return `${url.protocol === 'file:' ? 'file:' : ''}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
}
async function performPublication(
  ledger: SourcePublicationLedger,
  pod: Pod,
  expectedRepository: string,
  publish: (options: BranchPublicationOptions) => Promise<BranchPublicationReceipt> | Promise<void>,
): Promise<ConfirmedSourcePublication> {
  let intentId: string | undefined;
  const failure = () =>
    new AutopodError(
      'Source publication requires durable reconciliation; original resources must be retained.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
  if (!pod.worktreePath || !pod.branch) throw failure();
  const receipt = await publish({
    expectedRepository,
    onPrepared(source) {
      if (repositoryIdentity(source.repository) !== repositoryIdentity(expectedRepository))
        throw failure();
      intentId = ledger.admit(pod, source);
    },
  });
  if (!intentId || !receipt) throw failure();
  ledger.confirm(pod, intentId, receipt);
  return { ...receipt, publicationId: intentId };
}

export function publishSource(
  ledger: SourcePublicationLedger,
  pod: Pod,
  expectedRepository: string,
  manager: WorktreeManager,
  options?: Omit<BranchPublicationOptions, 'onPrepared'>,
): Promise<ConfirmedSourcePublication> {
  return performPublication(ledger, pod, expectedRepository, (admission) =>
    manager.pushBranch(pod.worktreePath ?? '', pod.branch, { ...options, ...admission }),
  );
}

export function publishCommittedSource(
  ledger: SourcePublicationLedger,
  pod: Pod,
  expectedRepository: string,
  manager: WorktreeManager,
  config: Omit<MergeBranchConfig, 'onPrepared' | 'expectedRepository'>,
): Promise<ConfirmedSourcePublication> {
  if (config.worktreePath !== pod.worktreePath || config.targetBranch !== pod.branch)
    throw new AutopodError(
      'Commit-and-push source identity changed; retain original resources.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
  return performPublication(ledger, pod, expectedRepository, (admission) =>
    manager.mergeBranch({ ...config, ...admission }),
  );
}
