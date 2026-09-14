import type { PimEligibility, PimSelection } from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import type { PimActivationProvider, PimProviderActivation } from './activation-service.js';
import { type PimApiClient, pimPages } from './api-client.js';

const text = z.string().min(1);
const base = '/v1.0/identityGovernance/privilegedAccess/group';
const directory = '/v1.0/roleManagement/directory';
const version = 'api-version=2020-10-01';
const scopeFields = {
  principalId: text,
  roleDefinitionId: text.optional(),
  scope: text.optional(),
  groupId: text.optional(),
  accessId: text.optional(),
  directoryScopeId: text.nullish(),
  appScopeId: text.nullish(),
};
const identitySchema = z.object(scopeFields);
function matches(raw: unknown, item: PimEligibility): boolean {
  const p = identitySchema.parse(raw);
  if (p.principalId !== item.principalId) return false;
  if (item.type === 'group') return p.groupId === item.scope && p.accessId === item.roleId;
  if (p.roleDefinitionId?.toLowerCase() !== item.provider.roleDefinitionId.toLowerCase())
    return false;
  if (item.type === 'azure-role') return p.scope?.toLowerCase() === item.scope.toLowerCase();
  return (
    (p.directoryScopeId ?? null) === (item.provider.directoryScopeId ?? null) &&
    (p.appScopeId ?? null) === (item.provider.appScopeId ?? null)
  );
}
function requestPath(item: PimEligibility, requestId?: string): string {
  if (item.type === 'azure-role')
    return `${item.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests${requestId ? `/${encodeURIComponent(requestId)}` : ''}?${version}`;
  return `${item.type === 'group' ? base : directory}/${item.type === 'group' ? 'assignmentScheduleRequests' : 'roleAssignmentScheduleRequests'}${requestId ? `/${encodeURIComponent(requestId)}` : ''}`;
}
export function createPimActivationProvider(
  client: PimApiClient,
  now: () => number = Date.now,
): PimActivationProvider {
  async function existing(item: PimEligibility): Promise<PimProviderActivation | null> {
    const filter = encodeURIComponent(`principalId eq '${item.principalId.replace(/'/g, "''")}'`);
    const rows = await pimPages(
      client,
      item.type === 'azure-role' ? 'arm' : 'graph',
      item.type === 'azure-role'
        ? `/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?${version}&$filter=asTarget()`
        : `${item.type === 'group' ? base : directory}/${item.type === 'group' ? 'assignmentScheduleInstances' : 'roleAssignmentScheduleInstances'}?$filter=${filter}`,
    );
    const active: PimProviderActivation[] = [];
    for (const row of rows) {
      const value =
        item.type === 'azure-role'
          ? z.object({ name: text, properties: z.unknown() }).parse(row).properties
          : row;
      if (!matches(value, item)) continue;
      const p = z
        .object({
          startDateTime: z.string().datetime({ offset: true }),
          endDateTime: z.string().datetime({ offset: true }).nullable(),
          assignmentScheduleId: text.optional(),
          roleAssignmentScheduleId: text.optional(),
        })
        .parse(value);
      if (
        Date.parse(p.startDateTime) > now() ||
        (p.endDateTime && Date.parse(p.endDateTime) <= now())
      )
        continue;
      const assignmentId = p.assignmentScheduleId ?? p.roleAssignmentScheduleId;
      if (!assignmentId)
        configurationError(
          'PIM active assignment has no schedule identity',
          'PIM_ACTIVATION_UNCONFIRMED',
          503,
        );
      active.push({ status: 'active', requestId: null, assignmentId, expiresAt: p.endDateTime });
    }
    if (active.length > 1)
      configurationError(
        'Multiple active PIM assignments need reconciliation',
        'PIM_ACTIVATION_AMBIGUOUS',
        409,
      );
    return active[0] ?? null;
  }
  async function parseRequest(item: PimEligibility, raw: unknown): Promise<PimProviderActivation> {
    const record =
      item.type === 'azure-role'
        ? z.object({ name: text, properties: z.unknown() }).parse(raw)
        : { name: z.object({ id: text }).parse(raw).id, properties: raw };
    if (!matches(record.properties, item))
      configurationError(
        'PIM activation response differs from the selected account/role/scope',
        'PIM_ACTIVATION_MISMATCH',
        403,
      );
    const p = z
      .object({
        status: text,
        targetScheduleId: text.nullish(),
        targetRoleAssignmentScheduleId: text.nullish(),
      })
      .parse(record.properties);
    const status = p.status.toLowerCase();
    if (['denied', 'failed', 'canceled', 'cancelled', 'revoked'].includes(status))
      return { status: 'failed', requestId: record.name, assignmentId: null, expiresAt: null };
    if (['granted', 'provisioned', 'schedulecreated'].includes(status)) {
      const assignment = await existing(item);
      const target = p.targetScheduleId ?? p.targetRoleAssignmentScheduleId;
      if (
        assignment?.assignmentId &&
        target &&
        assignment.assignmentId.toLowerCase() === target.toLowerCase()
      )
        return { ...assignment, requestId: record.name };
      // Provider acceptance may precede an observable assignment; it is not usable access yet.
      return { status: 'pending', requestId: record.name, assignmentId: null, expiresAt: null };
    }
    return {
      status:
        status.startsWith('pending') || ['accepted', 'provisioning', 'submitted'].includes(status)
          ? 'pending'
          : 'uncertain',
      requestId: record.name,
      assignmentId: null,
      expiresAt: null,
    };
  }
  return {
    existing,
    async submit(item: PimEligibility, selection: PimSelection, requestId: string) {
      const principalId = client.account.principalId;
      if (item.principalId !== principalId || item.tenantId !== client.account.tenantId)
        configurationError('PIM activation account changed', 'PIM_ACCOUNT_CHANGED', 403);
      const scheduleInfo = {
        startDateTime: new Date(now()).toISOString(),
        expiration: {
          type: item.type === 'azure-role' ? 'AfterDuration' : 'afterDuration',
          duration: selection.duration,
        },
      };
      const payload =
        item.type === 'azure-role'
          ? {
              properties: {
                principalId,
                roleDefinitionId: item.provider.roleDefinitionId,
                linkedRoleEligibilityScheduleId: item.provider.scheduleId,
                requestType: 'SelfActivate',
                scheduleInfo,
                justification: selection.justification,
              },
            }
          : {
              principalId,
              action: 'selfActivate',
              scheduleInfo,
              justification: selection.justification,
              ...(item.type === 'group'
                ? { groupId: item.scope, accessId: item.roleId }
                : {
                    roleDefinitionId: item.provider.roleDefinitionId,
                    ...(item.provider.appScopeId
                      ? { appScopeId: item.provider.appScopeId }
                      : { directoryScopeId: item.provider.directoryScopeId }),
                  }),
            };
      const raw = await client.mutate(
        item.type === 'azure-role' ? 'arm' : 'graph',
        item.type === 'azure-role' ? 'PUT' : 'POST',
        requestPath(item, item.type === 'azure-role' ? requestId : undefined),
        payload,
      );
      return parseRequest(item, raw);
    },
    async reconcile(item, requestId) {
      const raw = await client.get(
        item.type === 'azure-role' ? 'arm' : 'graph',
        requestPath(item, requestId),
      );
      return parseRequest(item, raw);
    },
  };
}
