import {
  AuthError,
  AutopodError,
  ProfileNotFoundError,
  SessionNotFoundError,
  ValidationError,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { DaemonUnreachableError } from '../api/client.js';
import { getExitCode } from './error-handler.js';

describe('getExitCode', () => {
  it('returns 2 for AuthError', () => {
    expect(getExitCode(new AuthError('nope'))).toBe(2);
  });

  it('returns 2 for FORBIDDEN', () => {
    expect(getExitCode(new AutopodError('nope', 'FORBIDDEN', 403))).toBe(2);
  });

  it('returns 3 for SessionNotFoundError', () => {
    expect(getExitCode(new SessionNotFoundError('abc'))).toBe(3);
  });

  it('returns 3 for ProfileNotFoundError', () => {
    expect(getExitCode(new ProfileNotFoundError('test'))).toBe(3);
  });

  it('returns 4 for ValidationError', () => {
    expect(getExitCode(new ValidationError('bad'))).toBe(4);
  });

  it('returns 5 for DaemonUnreachableError', () => {
    expect(getExitCode(new DaemonUnreachableError('http://localhost:3100'))).toBe(5);
  });

  it('returns 1 for unknown AutopodError', () => {
    expect(getExitCode(new AutopodError('wat', 'SOMETHING', 500))).toBe(1);
  });

  it('returns 1 for generic Error', () => {
    expect(getExitCode(new Error('boom'))).toBe(1);
  });
});
