import type { RuntimeType } from './types/runtime.js';
import type { PodStatus } from './types/pod.js';

export class AutopodError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AutopodError';
  }
}

export class AuthError extends AutopodError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AutopodError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export class PodNotFoundError extends AutopodError {
  constructor(podId: string) {
    super(`Pod ${podId} not found`, 'POD_NOT_FOUND', 404);
    this.name = 'PodNotFoundError';
  }
}

export class InvalidStateTransitionError extends AutopodError {
  constructor(podId: string, from: PodStatus, to: PodStatus) {
    super(
      `Cannot transition pod ${podId} from ${from} to ${to}`,
      'INVALID_STATE_TRANSITION',
      409,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class ProfileNotFoundError extends AutopodError {
  constructor(name: string) {
    super(`Profile "${name}" not found`, 'PROFILE_NOT_FOUND', 404);
    this.name = 'ProfileNotFoundError';
  }
}

export class ProfileExistsError extends AutopodError {
  constructor(name: string) {
    super(`Profile "${name}" already exists`, 'PROFILE_EXISTS', 409);
    this.name = 'ProfileExistsError';
  }
}

export class ContainerError extends AutopodError {
  constructor(message: string) {
    super(message, 'CONTAINER_ERROR', 500);
    this.name = 'ContainerError';
  }
}

export class ValidationError extends AutopodError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 500);
    this.name = 'ValidationError';
  }
}

export class EscalationNotFoundError extends AutopodError {
  constructor(id: string) {
    super(`Escalation ${id} not found`, 'ESCALATION_NOT_FOUND', 404);
    this.name = 'EscalationNotFoundError';
  }
}

export class RuntimeError extends AutopodError {
  constructor(
    message: string,
    public readonly runtime: RuntimeType,
  ) {
    super(message, 'RUNTIME_ERROR', 500);
    this.name = 'RuntimeError';
  }
}
