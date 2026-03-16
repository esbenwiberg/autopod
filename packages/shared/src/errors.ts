import type { RuntimeType } from './types/runtime.js';
import type { SessionStatus } from './types/session.js';

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

export class SessionNotFoundError extends AutopodError {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND', 404);
    this.name = 'SessionNotFoundError';
  }
}

export class InvalidStateTransitionError extends AutopodError {
  constructor(sessionId: string, from: SessionStatus, to: SessionStatus) {
    super(
      `Cannot transition session ${sessionId} from ${from} to ${to}`,
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

export class RuntimeError extends AutopodError {
  constructor(
    message: string,
    public readonly runtime: RuntimeType,
  ) {
    super(message, 'RUNTIME_ERROR', 500);
    this.name = 'RuntimeError';
  }
}
