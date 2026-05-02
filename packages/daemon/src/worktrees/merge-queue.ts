import { KeyedPromiseQueue } from '../util/keyed-promise-queue.js';

/**
 * Sequential queue for merge operations, keyed by `repo+baseBranch`.
 *
 * Two pods conflict only if they target the same base branch on the same
 * repository. Different repos and different base branches are independent.
 *
 * The "rebase + push + merge attempt" critical section runs inside this queue
 * so two pods on the same base never race: pod B's rebase always happens
 * against the freshly pushed/merged state of any preceding pod, eliminating
 * the "both rebases looked clean, B's became stale before push" failure mode.
 */
export class MergeQueue extends KeyedPromiseQueue {
  static keyFor(repoUrl: string | null | undefined, baseBranch: string): string {
    return `${repoUrl ?? '<no-repo>'}::${baseBranch}`;
  }
}
