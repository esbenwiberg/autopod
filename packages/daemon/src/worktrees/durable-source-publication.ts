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
      // A confirmed content intent cannot describe another external mutation.
      // Unsupported adapters must fail closed instead of reusing its receipt.
      if (ledger.get(intentId)?.state === 'confirmed') throw failure();
    },
  });
  if (!intentId || !receipt) throw failure();
  ledger.confirm(pod, intentId, receipt);
  return { ...receipt, publicationId: intentId };
}

async function reuseConfirmedPublication(
  ledger: SourcePublicationLedger,
  pod: Pod,
  repository: string,
  manager: WorktreeManager,
  assertPrepared?: (source: BranchPublicationSource) => void,
  pat?: string,
): Promise<ConfirmedSourcePublication | null> {
  const prior = ledger.latestConfirmedForMerge?.(pod);
  // The intentional null→PR attachment is a different identity. Existing
  // approval planning must retain its explicit PR-bound publication contract.
  if (!prior || prior.publicationPrUrl !== pod.prUrl) return null;
  if (!manager.inspectSource || !pod.worktreePath || !ledger.assertDeliveryAllowed)
    throw new AutopodError(
      'Confirmed publication needs current read-only source/owner verification; no second push is authorized.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
  ledger.assertDeliveryAllowed(pod, prior);
  const local = await manager.inspectSource(pod.worktreePath, pod.branch);
  if (
    !local.worktreeClean ||
    local.commitSha !== prior.commitSha ||
    local.treeSha !== prior.treeSha
  )
    return null;
  // Fresh checks and present ownership are independent of the historical push.
  assertPrepared?.(prior);
  const observed = await reconcilePublication(
    ledger,
    pod,
    repository,
    manager,
    { id: prior.publicationId, source: prior },
    assertPrepared,
    pat,
  );
  ledger.assertDeliveryAllowed(pod, prior);
  return observed;
}

export async function publishSource(
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
  const confirmed = await reuseConfirmedPublication(
    ledger,
    pod,
    expectedRepository,
    manager,
    assertPrepared,
    options?.pat,
  );
  if (confirmed) return confirmed;
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

export async function publishCommittedSource(
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
  const confirmed = await reuseConfirmedPublication(
    ledger,
    pod,
    expectedRepository,
    manager,
    undefined,
    config.pat,
  );
  if (confirmed) return confirmed;
  return performPublication(ledger, pod, expectedRepository, (admission) =>
    manager.mergeBranch({ ...config, ...admission }),
  );
}
