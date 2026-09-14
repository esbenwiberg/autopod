import type {
  PimDiscovery,
  PimDiscoveryFamily,
  PimEligibility,
  PimSelection,
} from '@autopod/shared';
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
export interface PimPolicyReader {
  maximumDurationMinutes(eligibility: PimEligibility, signal?: AbortSignal): Promise<number>;
}

export function createPimEligibilityService(
  client: PimApiClient,
  policy: PimPolicyReader,
  now: () => number = Date.now,
) {
  let cached: { until: number; value: PimDiscovery } | null = null;
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
        try {
          const maximum = await policy.maximumDurationMinutes(item, signal);
          if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('Invalid duration policy');
          item.maximumDurationMinutes = maximum;
        } catch {
          item.policyUnavailableReason =
            'Activation duration policy is unavailable for this assignment';
        }
        assignments.push(item);
      }
      signal.throwIfAborted();
      return { type, available: true, assignments };
    } catch {
      return {
        type,
        available: false,
        assignments: [],
        reason: `Could not completely discover ${type} eligibility for the configured user; check provider permissions and connectivity`,
      };
    }
  }
  async function discover(fresh = false): Promise<PimDiscovery> {
    if (!fresh && cached && cached.until > now()) return structuredClone(cached.value);
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
    const families = await Promise.all(
      (['group', 'azure-role', 'directory-role'] as const).map((type) => family(type, signal)),
    );
    const value = {
      account: client.account,
      discoveredAt: new Date(now()).toISOString(),
      families,
    };
    if (families.every((item) => item.available)) cached = { until: now() + 30_000, value };
    return structuredClone(value);
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
