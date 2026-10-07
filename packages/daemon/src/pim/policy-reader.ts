import type { PimEligibility } from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { type PimApiClient, pimPages } from './api-client.js';
import type { PimPolicyReader } from './eligibility-service.js';

export function pimDurationMinutes(duration: string): number {
  const parts = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!parts) configurationError('Invalid PIM duration', 'PIM_INVALID_DURATION');
  const minutes =
    Number(parts[1] ?? 0) * 1440 +
    Number(parts[2] ?? 0) * 60 +
    Number(parts[3] ?? 0) +
    Number(parts[4] ?? 0) / 60;
  if (!Number.isFinite(minutes) || minutes <= 0)
    configurationError('PIM duration must be positive', 'PIM_INVALID_DURATION');
  return minutes;
}
const ruleSchema = z.object({
  id: z.string(),
  maximumDuration: z.string().optional(),
  target: z.object({ caller: z.string(), level: z.string() }).optional(),
});
export function pimMaximumDuration(rules: unknown): number {
  const values = z
    .array(ruleSchema)
    .parse(rules)
    .filter(
      (item) =>
        item.id === 'Expiration_EndUser_Assignment' &&
        item.target?.caller === 'EndUser' &&
        item.target.level === 'Assignment',
    );
  const rule = values[0];
  if (values.length !== 1 || !rule?.maximumDuration)
    configurationError(
      'Exact activation duration policy is unavailable',
      'PIM_POLICY_UNAVAILABLE',
      503,
    );
  return pimDurationMinutes(rule.maximumDuration);
}
/** Admin-managed and rarely changed; activation re-validates against the provider anyway. */
const POLICY_TTL_MS = 60 * 60_000;
export function createPimPolicyReader(
  client: PimApiClient,
  now: () => number = Date.now,
): PimPolicyReader {
  // Policies belong to (scope, role), not to an eligibility, so every assignment sharing one hits
  // the provider once per TTL. Promises are cached so concurrent reads share the round trip.
  const cache = new Map<string, { until: number; value: Promise<number> }>();
  return {
    maximumDurationMinutes(item: PimEligibility, signal?: AbortSignal) {
      const key =
        item.type === 'azure-role'
          ? `arm|${item.scope.toLowerCase()}|${item.provider.roleDefinitionId.toLowerCase()}`
          : `${item.type}|${item.type === 'group' ? item.scope : '/'}|${item.roleId}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;
      const value = read(item, signal);
      cache.set(key, { until: now() + POLICY_TTL_MS, value });
      // Never pin a failure (permission, outage, abort) for the whole TTL.
      value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
      });
      return value;
    },
  };
  async function read(item: PimEligibility, signal?: AbortSignal): Promise<number> {
    const quote = (value: string) => value.replace(/'/g, "''");
    if (item.type === 'azure-role') {
      const filter = encodeURIComponent(
        `roleDefinitionId eq '${quote(item.provider.roleDefinitionId)}'`,
      );
      const values = await pimPages(
        client,
        'arm',
        `${item.scope}/providers/Microsoft.Authorization/roleManagementPolicyAssignments?api-version=2020-10-01&$filter=${filter}`,
        signal,
      );
      const schema = z.object({
        properties: z.object({
          roleDefinitionId: z.string(),
          policyId: z.string(),
          scope: z.string(),
        }),
      });
      const matching = values
        .map((value) => schema.parse(value))
        .filter(
          (value) =>
            value.properties.roleDefinitionId.toLowerCase() ===
              item.provider.roleDefinitionId.toLowerCase() &&
            value.properties.scope.toLowerCase() === item.scope.toLowerCase(),
        );
      const match = matching[0];
      if (matching.length !== 1 || !match)
        configurationError(
          'Exact resource PIM policy is unavailable',
          'PIM_POLICY_UNAVAILABLE',
          503,
        );
      const policy = z
        .object({ properties: z.object({ rules: z.unknown() }) })
        .parse(
          await client.get('arm', `${match.properties.policyId}?api-version=2020-10-01`, signal),
        );
      return pimMaximumDuration(policy.properties.rules);
    }
    const scopeId = item.type === 'group' ? item.scope : '/';
    const scopeType = item.type === 'group' ? 'Group' : 'DirectoryRole';
    const filter = encodeURIComponent(
      `scopeId eq '${quote(scopeId)}' and scopeType eq '${scopeType}' and roleDefinitionId eq '${quote(item.roleId)}'`,
    );
    const values = await pimPages(
      client,
      'graph',
      `/v1.0/policies/roleManagementPolicyAssignments?$filter=${filter}&$expand=policy($expand=rules)`,
      signal,
    );
    const schema = z.object({
      scopeId: z.string(),
      scopeType: z.string(),
      roleDefinitionId: z.string(),
      policy: z.object({ rules: z.unknown() }),
    });
    const matching = values
      .map((value) => schema.parse(value))
      .filter(
        (value) =>
          value.scopeId === scopeId &&
          value.scopeType === scopeType &&
          value.roleDefinitionId === item.roleId,
      );
    const match = matching[0];
    if (matching.length !== 1 || !match)
      configurationError(
        'Exact group/directory PIM policy is unavailable',
        'PIM_POLICY_UNAVAILABLE',
        503,
      );
    return pimMaximumDuration(match.policy.rules);
  }
}
