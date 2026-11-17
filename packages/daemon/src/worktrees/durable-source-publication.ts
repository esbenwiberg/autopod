import { AutopodError, type Pod } from '@autopod/shared';
import type {
  BranchPublicationOptions,
  BranchPublicationReceipt,
  BranchPublicationSource,
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
  assertPrepared?: (source: BranchPublicationSource) => void,
): Promise<ConfirmedSourcePublication> {
  const pending = ledger.pending?.(pod);
  if (pending)
    return reconcilePublication(
      ledger,
      pod,
      expectedRepository,
      manager,
      pending,
      assertPrepared,
      options?.pat,
    );
  return performPublication(ledger, pod, expectedRepository, (admission) =>
    manager.pushBranch(pod.worktreePath ?? '', pod.branch, {
      ...options,
      ...admission,
      onPrepared(source) {
        assertPrepared?.(source);
        admission.onPrepared?.(source);
      },
    }),
  );
}

/** Observe an already-admitted push; this entry point cannot dispatch a new push. */
export async function reconcilePublication(
  ledger: SourcePublicationLedger,
  pod: Pod,
  repository: string,
  manager: WorktreeManager,
  pending: { id: string; source: BranchPublicationSource },
  assertPrepared?: (source: BranchPublicationSource) => void,
  pat?: string,
): Promise<ConfirmedSourcePublication> {
  const fail = (): never => {
    throw new AutopodError(
      'The original publication outcome remains unverified. Retain its source and resources; inspect source-recovery. No second push was admitted.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
  };
  if (
    repositoryIdentity(repository) !== repositoryIdentity(pending.source.repository) ||
    !manager.observeSourceBranch ||
    !manager.inspectSource ||
    !pod.worktreePath
  )
    return fail();
  assertPrepared?.(pending.source);
  const remote = await manager.observeSourceBranch(pod.worktreePath, repository, pod.branch, pat);
  const local = await manager.inspectSource(pod.worktreePath, pod.branch);
  if (
    remote !== pending.source.commitSha ||
    !local.worktreeClean ||
    local.branch !== pod.branch ||
    local.commitSha !== pending.source.commitSha ||
    local.treeSha !== pending.source.treeSha
  )
    return fail();
  assertPrepared?.(pending.source);
  const receipt = {
    ...pending.source,
    observedRemoteCommitSha: remote,
    observedAt: new Date().toISOString(),
  };
  ledger.confirm(pod, pending.id, receipt);
  return { ...receipt, publicationId: pending.id };
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
  const pending = ledger.pending?.(pod);
  if (pending)
    return reconcilePublication(
      ledger,
      pod,
      expectedRepository,
      manager,
      pending,
      undefined,
      config.pat,
    );
  return performPublication(ledger, pod, expectedRepository, (admission) =>
    manager.mergeBranch({ ...config, ...admission }),
  );
}
