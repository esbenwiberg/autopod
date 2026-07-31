import type { ExecutionTarget } from '@autopod/shared';

const PINNED_ACR_IMAGE = /^[a-z0-9-]+\.azurecr\.io\/.+(?::[^/]+|@sha256:[a-f0-9]{64})$/i;

export function resolveSystemDecisionExecutionTarget(hasSandboxBackend: boolean): ExecutionTarget {
  return hasSandboxBackend ? 'sandbox' : 'local';
}

export function isPinnedHostedSystemDecisionImage(image: string | undefined): boolean {
  return Boolean(image && PINNED_ACR_IMAGE.test(image) && !image.endsWith(':latest'));
}
