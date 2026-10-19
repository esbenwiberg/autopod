import type { ProviderAccount } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  nativeGoalCapability,
  nativeGoalEvidenceSchema,
} from '../runtimes/native-goal-capability.js';

/** Availability is bound to authenticated accounts and recoverable, accepted backends. */
export function nativeGoalCapabilities(
  accounts: ProviderAccount[],
  evidence: readonly unknown[],
  manager: (target: 'local' | 'sandbox') => ContainerManager,
  enabled: (target: 'local' | 'sandbox') => boolean,
) {
  const records = evidence.flatMap((raw) => {
    const parsed = nativeGoalEvidenceSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  return accounts.flatMap((account) =>
    (['local', 'sandbox'] as const).flatMap((backend) => {
      if (!account.credentials || !enabled(backend)) return [];
      const accepted = records.filter(
        (record) =>
          nativeGoalCapability(
            {
              runtime: record.runtime,
              runtimeVersion: record.runtimeVersion,
              imageDigest: record.imageDigest,
              backend,
              providerId: account.provider,
              accountId: account.id,
            },
            [record],
          ).available,
      );
      if (!accepted.length || !manager(backend).supportsExecRecovery) return [];
      return accepted.map((record) => ({
        runtime: record.runtime,
        accountId: account.id,
        backend,
        available: true,
        imageDigest: record.imageDigest,
        runtimeVersion: record.runtimeVersion,
        evidenceId: record.evidenceId,
      }));
    }),
  );
}
