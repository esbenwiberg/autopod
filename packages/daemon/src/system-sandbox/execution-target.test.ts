import { describe, expect, it } from 'vitest';
import {
  isPinnedHostedSystemDecisionImage,
  resolveSystemDecisionExecutionTarget,
} from './execution-target.js';

describe('system decision execution target', () => {
  it('selects Azure sandbox whenever the backend is configured', () => {
    expect(resolveSystemDecisionExecutionTarget(true)).toBe('sandbox');
  });

  it('keeps local-only development on Docker', () => {
    expect(resolveSystemDecisionExecutionTarget(false)).toBe('local');
  });

  it('accepts only immutable ACR-hosted decision images', () => {
    expect(
      isPinnedHostedSystemDecisionImage(
        'ewiautopodacr.azurecr.io/autopod/system-decision:95fe98e6',
      ),
    ).toBe(true);
    expect(
      isPinnedHostedSystemDecisionImage(
        `ewiautopodacr.azurecr.io/autopod/system-decision@sha256:${'a'.repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      isPinnedHostedSystemDecisionImage('ewiautopodacr.azurecr.io/autopod/system-decision:latest'),
    ).toBe(false);
    expect(isPinnedHostedSystemDecisionImage('autopod-system-decision:local')).toBe(false);
    expect(isPinnedHostedSystemDecisionImage(undefined)).toBe(false);
  });
});
