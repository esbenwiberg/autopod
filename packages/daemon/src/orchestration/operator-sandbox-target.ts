import type { Logger } from 'pino';
import { z } from 'zod';
import {
  SandboxContainerManager,
  type SandboxContainerManagerOptions,
} from '../containers/sandbox-container-manager.js';
import { digest } from '../managed/canonical.js';

const targetSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    resourceGroup: z
      .string()
      .max(90)
      .regex(/^[A-Za-z0-9_.()-]+$/)
      .refine((name) => !name.endsWith('.')),
    location: z
      .string()
      .max(40)
      .regex(/^[a-z][a-z0-9]+$/),
    sandboxGroup: z
      .string()
      .max(63)
      .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  })
  .strict();

interface SignedTarget {
  readonly resourceScopeDigest: string;
  readonly readyDiskImageId: string;
}

/** No target inheritance from the ordinary fleet and no discovery or Azure calls at boot. */
export function composeOperatorSandboxTarget(
  raw: string | undefined,
  signed: SignedTarget | undefined,
  logger: Logger,
  options: Pick<SandboxContainerManagerOptions, 'managedDatabase' | 'wakeupJournal'>,
) {
  if (!signed) {
    if (raw !== undefined) throw new Error('operator-sandbox-target-without-enrollment');
    return undefined;
  }
  const target = (() => {
    try {
      if (raw === undefined || Buffer.byteLength(raw) > 2048) throw new Error();
      return targetSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error('operator-sandbox-target-required');
    }
  })();
  const manager = SandboxContainerManager.withAzureClient(
    { ...target, assumeGroupExists: true, readyDiskImageId: signed.readyDiskImageId, tier: 'S' },
    logger,
    options,
  );
  const scope = manager.executionResourceScope;
  if (!scope || digest(scope) !== signed.resourceScopeDigest)
    throw new Error('parent-sandbox-coding-runtime-mismatch');
  return manager;
}
