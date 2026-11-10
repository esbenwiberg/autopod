import { AutopodError, type RecoveryForkRequest } from '@autopod/shared';

/** Created only by the read-only coordinator boundary, never by an HTTP absence lookup. */
export class RecoveryForkRejectedBeforeClaim extends AutopodError {
  readonly noOperationCreated = true;
  constructor(
    readonly parentPodId: string,
    request: RecoveryForkRequest,
    readonly reasonCode: string,
  ) {
    super(
      'Recovery selection was rejected before claiming source. Inspect and preview again.',
      'RECOVERY_FORK_REJECTED_BEFORE_CLAIM',
      409,
    );
    this.requestId = request.id;
    this.expectedBinding = request.expectedBinding;
  }
  readonly requestId: string;
  readonly expectedBinding: string;
}

/** Server-owned selection/policy failure. This brand alone never proves absence:
 * the coordinator must still confirm ownership and have made no claim attempt. */
export class RecoveryForkSelectionError extends AutopodError {
  constructor(message: string, code = 'RECOVERY_FORK_BLOCKED') {
    super(message, code, 409);
  }
}

export function recoveryForkError(message: string, code = 'RECOVERY_FORK_BLOCKED'): never {
  throw new RecoveryForkSelectionError(message, code);
}
