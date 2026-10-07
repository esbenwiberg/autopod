import type {
  PimDiscovery,
  PimDiscoveryFamily,
  PimEligibility,
  PimSelection,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { type PimApiClient, pimPages } from './api-client.js';

const text = z.string().min(1);
const date = z.string().datetime({ offset: true });
const dates = { startDateTime: date, endDateTime: date.nullish() };
const display = z.object({ displayName: text }).nullish();
const directorySchema = z.object({
  id: text,
  principalId: text,
  roleDefinitionId: text,
  roleEligibilityScheduleId: text,
  directoryScopeId: text.nullish(),
  appScopeId: text.nullish(),
  roleDefinition: display,
  ...dates,
});
const groupSchema = z.object({
  id: text,
  principalId: text,
  groupId: text,
  accessId: z.enum(['member', 'owner']),
  eligibilityScheduleId: text,
  group: display,
  ...dates,
});
const armSchema = z.object({
  name: text,
  properties: z.object({
    principalId: text,
    roleDefinitionId: text,
    roleEligibilityScheduleId: text,
    scope: text,
    ...dates,
    expandedProperties: z.object({ roleDefinition: display, scope: display }).optional(),
  }),
});
const FAMILIES = ['group', 'azure-role', 'directory-role'] as const;
/** Eligibility changes rarely; activation re-reads fresh, so a few minutes of staleness is display-only. */
const FAMILY_TTL_MS = 5 * 60_000;
/** Short so a fixed permission or outage shows up quickly without hammering the provider. */
const FAILED_FAMILY_TTL_MS = 60_000;
const POLICY_CONCURRENCY = 6;
interface FamilyCacheEntry {
  at: number;
  until: number;
  value: PimDiscoveryFamily;
}
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
export interface PimPolicyReader {
  maximumDurationMinutes(eligibility: PimEligibility, signal?: AbortSignal): Promise<number>;
}

export function createPimEligibilityService(
  client: PimApiClient,
  policy: PimPolicyReader,
  now: () => number = Date.now,
) {
  const familyCache = new Map<PimSelection['type'], FamilyCacheEntry>();
  let refreshing: Promise<void> | null = null;
  async function family(
    type: PimSelection['type'],
    signal: AbortSignal,
  ): Promise<PimDiscoveryFamily> {
    try {
      const filter = encodeURIComponent(
        `principalId eq '${client.account.principalId.replace(/'/g, "''")}'`,
      );
      const raw = await pimPages(
        client,
        type === 'azure-role' ? 'arm' : 'graph',
        type === 'azure-role'
          ? '/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()'
          : type === 'group'
            ? `/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?$filter=${filter}&$expand=group`
            : `/v1.0/roleManagement/directory/roleEligibilityScheduleInstances?$filter=${filter}&$expand=roleDefinition`,
        signal,
      );
      const assignments: PimEligibility[] = [];
      const seen = new Set<string>();
      for (const value of raw) {
        signal.throwIfAborted();
        let item: PimEligibility;
        const common = { ...client.account, type, maximumDurationMinutes: null };
        if (type === 'azure-role') {
          const { name, properties: p } = armSchema.parse(value);
          const roleId = p.roleDefinitionId.split('/').pop();
          if (!roleId) throw new Error('Missing role identity');
          item = {
            ...common,
            eligibilityId: name,
            principalId: p.principalId,
            roleId,
            scope: p.scope,
            displayName: p.expandedProperties?.roleDefinition?.displayName ?? roleId,
            scopeName: p.expandedProperties?.scope?.displayName ?? p.scope,
            startsAt: p.startDateTime,
            expiresAt: p.endDateTime ?? null,
            provider: {
              scheduleId: p.roleEligibilityScheduleId,
              roleDefinitionId: p.roleDefinitionId,
            },
          };
        } else if (type === 'directory-role') {
          const p = directorySchema.parse(value);
          if (!p.directoryScopeId && !p.appScopeId) throw new Error('Missing exact scope');
          item = {
            ...common,
            eligibilityId: p.id,
            principalId: p.principalId,
            roleId: p.roleDefinitionId,
            scope: p.appScopeId ? `application:${p.appScopeId}` : (p.directoryScopeId ?? '/'),
            displayName: p.roleDefinition?.displayName ?? p.roleDefinitionId,
            scopeName: p.appScopeId
              ? `Application ${p.appScopeId}`
              : p.directoryScopeId === '/'
                ? 'Tenant'
                : (p.directoryScopeId ?? '/'),
            startsAt: p.startDateTime,
            expiresAt: p.endDateTime ?? null,
            provider: {
              scheduleId: p.roleEligibilityScheduleId,
              roleDefinitionId: p.roleDefinitionId,
              directoryScopeId: p.directoryScopeId ?? null,
              appScopeId: p.appScopeId ?? null,
            },
          };
        } else {
          const p = groupSchema.parse(value);
          item = {
            ...common,
            eligibilityId: p.id,
            principalId: p.principalId,
            roleId: p.accessId,
            scope: p.groupId,
            displayName: `${p.group?.displayName ?? p.groupId} (${p.accessId})`,
            scopeName: p.group?.displayName ?? p.groupId,
            startsAt: p.startDateTime,
            expiresAt: p.endDateTime ?? null,
            provider: { scheduleId: p.eligibilityScheduleId, roleDefinitionId: p.accessId },
          };
        }
        // asTarget() may include group-derived assignments. They are not this user's exact assignment.
        if (item.principalId !== client.account.principalId) continue;
        if (
          Date.parse(item.startsAt) > now() ||
          (item.expiresAt && Date.parse(item.expiresAt) <= now())
        )
          continue;
        if (seen.has(item.eligibilityId)) throw new Error('Duplicate eligibility identity');
        seen.add(item.eligibilityId);
        assignments.push(item);
      }
      // Policy reads are two provider round trips per assignment; sequential reads made discovery
      // scale linearly (~1s per call). Bounded so a large eligibility list cannot fan out unchecked.
      await eachLimited(assignments, POLICY_CONCURRENCY, async (item) => {
        try {
          const maximum = await policy.maximumDurationMinutes(item, signal);
          if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('Invalid duration policy');
          item.maximumDurationMinutes = maximum;
        } catch {
          item.policyUnavailableReason =
            'Activation duration policy is unavailable for this assignment';
        }
      });
      signal.throwIfAborted();
      return { type, available: true, assignments };
    } catch (error) {
      // Surface only our own error code; provider bodies may carry identifiers.
      const code = error instanceof AutopodError ? ` (${error.code})` : '';
      return {
        type,
        available: false,
        assignments: [],
        reason: `Could not completely discover ${type} eligibility for the configured user; check provider permissions and connectivity${code}`,
      };
    }
  }
  async function load(types: readonly PimSelection['type'][]): Promise<void> {
    const signal = AbortSignal.timeout(45_000);
    const me = z
      .object({ id: text })
      .parse(await client.get('graph', '/v1.0/me?$select=id', signal));
    if (me.id !== client.account.principalId)
      configurationError(
        'PIM discovery account differs from the configured user',
        'PIM_ACCOUNT_CHANGED',
        403,
      );
    const fetched = await Promise.all(types.map((type) => family(type, signal)));
    const at = now();
    for (const value of fetched)
      familyCache.set(value.type, {
        at,
        until: at + (value.available ? FAMILY_TTL_MS : FAILED_FAMILY_TTL_MS),
        value,
      });
  }
  /**
   * Cached per family so a family the provider refuses (e.g. missing Graph scopes) cannot keep
   * the healthy ones uncached. `fresh` always re-reads the provider; activation relies on that.
   */
  async function discover(fresh = false): Promise<PimDiscovery> {
    if (fresh) await load(FAMILIES);
    else
      for (let round = 0; round < 2; round++) {
        const stale = FAMILIES.filter((type) => !((familyCache.get(type)?.until ?? 0) > now()));
        if (stale.length === 0) break;
        // Concurrent opens share one provider round instead of each paying for it.
        refreshing ??= load(stale).finally(() => {
          refreshing = null;
        });
        await refreshing;
      }
    const entries: FamilyCacheEntry[] = [];
    for (const type of FAMILIES) {
      const entry = familyCache.get(type);
      if (!entry)
        configurationError('PIM discovery is incomplete', 'PIM_DISCOVERY_INCOMPLETE', 503);
      entries.push(entry);
    }
    return structuredClone({
      account: client.account,
      // The oldest family bounds how stale the whole answer may be.
      discoveredAt: new Date(Math.min(...entries.map((entry) => entry.at))).toISOString(),
      families: entries.map((entry) => entry.value),
    });
  }
  return {
    discover,
    async selected(selection: PimSelection): Promise<PimEligibility> {
      if (
        selection.principalId !== client.account.principalId ||
        selection.tenantId !== client.account.tenantId
      )
        configurationError(
          'Selected PIM assignment belongs to a different account',
          'PIM_ACCOUNT_CHANGED',
          403,
        );
      const result = await discover(true);
      const source = result.families.find((item) => item.type === selection.type);
      if (!source?.available)
        configurationError('Selected PIM family is unavailable', 'PIM_DISCOVERY_INCOMPLETE', 503);
      const matches = source.assignments.filter(
        (item) =>
          item.eligibilityId === selection.eligibilityId &&
          item.scope === selection.scope &&
          item.roleId === selection.roleId,
      );
      if (matches.length !== 1)
        configurationError(
          'Exact PIM eligibility was revoked, expired or changed; select it again',
          'PIM_ELIGIBILITY_CHANGED',
          403,
        );
      if (
        selection.type !== 'azure-role' &&
        source.assignments.filter(
          (item) => item.scope === selection.scope && item.roleId === selection.roleId,
        ).length !== 1
      )
        configurationError(
          'Provider activation cannot uniquely bind this eligibility; resolve overlapping assignments first',
          'PIM_ELIGIBILITY_AMBIGUOUS',
          403,
        );
      return matches[0] as PimEligibility;
    },
  };
}
export type PimEligibilityService = ReturnType<typeof createPimEligibilityService>;
