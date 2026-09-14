import type { PimEligibility, PimSelection } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createPimActivationProvider } from './activation-provider.js';
import type { PimApiClient } from './api-client.js';

const account = { tenantId: 'tenant', principalId: 'user' };
const now = () => Date.parse('2026-09-13T00:00:00Z');
const selection: PimSelection = {
  ...account,
  type: 'group',
  eligibilityId: 'eligible',
  roleId: 'member',
  scope: 'group',
  displayName: 'Group',
  timing: 'when-needed',
  duration: 'PT1H',
  justification: 'Debug',
};
const item: PimEligibility = {
  ...selection,
  scopeName: 'Group',
  startsAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  maximumDurationMinutes: 60,
  provider: { scheduleId: 'eligibility-schedule', roleDefinitionId: 'member' },
};
function fixture() {
  const client: PimApiClient = { account, get: vi.fn(), mutate: vi.fn() };
  return { client, provider: createPimActivationProvider(client, now) };
}
describe('PIM provider effects', () => {
  it('keeps approval pending and takes principal, scope and duration only from the saved selection', async () => {
    const f = fixture();
    vi.mocked(f.client.mutate).mockResolvedValue({
      id: 'provider-request',
      status: 'PendingApproval',
      principalId: 'user',
      groupId: 'group',
      accessId: 'member',
    });
    expect(await f.provider.submit(item, selection, 'operation')).toMatchObject({
      status: 'pending',
      assignmentId: null,
    });
    expect(f.client.mutate).toHaveBeenCalledWith(
      'graph',
      'POST',
      expect.stringContaining('/group/assignmentScheduleRequests'),
      expect.objectContaining({
        principalId: 'user',
        groupId: 'group',
        accessId: 'member',
        action: 'selfActivate',
        scheduleInfo: expect.objectContaining({
          expiration: { type: 'afterDuration', duration: 'PT1H' },
        }),
      }),
    );
  });
  it('does not confuse provider acceptance with active access or another scope with this one', async () => {
    const f = fixture();
    vi.mocked(f.client.mutate).mockResolvedValue({
      id: 'provider-request',
      status: 'Provisioned',
      principalId: 'user',
      groupId: 'group',
      accessId: 'member',
      targetScheduleId: 'assignment',
    });
    vi.mocked(f.client.get).mockResolvedValue({
      value: [
        {
          principalId: 'user',
          groupId: 'different',
          accessId: 'member',
          assignmentScheduleId: 'assignment',
          startDateTime: '2026-09-13T00:00:00Z',
          endDateTime: '2026-09-13T01:00:00Z',
        },
      ],
    });
    expect(await f.provider.submit(item, selection, 'operation')).toMatchObject({
      status: 'pending',
      assignmentId: null,
    });
  });
  it('activates Azure at the exact scope with its linked eligibility and stable request identity', async () => {
    const f = fixture();
    const azure: PimEligibility = {
      ...item,
      type: 'azure-role',
      roleId: 'reader',
      scope: '/subscriptions/sub/resourceGroups/exact',
      provider: {
        scheduleId: 'exact-schedule',
        roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/reader',
      },
    };
    vi.mocked(f.client.mutate).mockResolvedValue({
      name: 'operation',
      properties: {
        status: 'Accepted',
        principalId: 'user',
        scope: azure.scope,
        roleDefinitionId: azure.provider.roleDefinitionId,
      },
    });
    expect(await f.provider.submit(azure, { ...selection, ...azure }, 'operation')).toMatchObject({
      status: 'pending',
    });
    expect(f.client.mutate).toHaveBeenCalledWith(
      'arm',
      'PUT',
      `${azure.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/operation?api-version=2020-10-01`,
      expect.objectContaining({
        properties: expect.objectContaining({
          linkedRoleEligibilityScheduleId: 'exact-schedule',
          principalId: 'user',
        }),
      }),
    );
  });
  it('supports exact application-scoped directory roles independently of groups', async () => {
    const f = fixture();
    const directory: PimEligibility = {
      ...item,
      type: 'directory-role',
      roleId: 'reader',
      scope: 'application:app',
      provider: {
        scheduleId: 'exact',
        roleDefinitionId: 'reader',
        directoryScopeId: null,
        appScopeId: 'app',
      },
    };
    vi.mocked(f.client.mutate).mockResolvedValue({
      id: 'request',
      status: 'PendingApproval',
      principalId: 'user',
      roleDefinitionId: 'reader',
      directoryScopeId: null,
      appScopeId: 'app',
    });
    await f.provider.submit(directory, { ...selection, ...directory }, 'operation');
    expect(f.client.mutate).toHaveBeenCalledWith(
      'graph',
      'POST',
      '/v1.0/roleManagement/directory/roleAssignmentScheduleRequests',
      expect.objectContaining({ appScopeId: 'app', roleDefinitionId: 'reader' }),
    );
    expect(vi.mocked(f.client.mutate).mock.calls[0]?.[3]).not.toHaveProperty('groupId');
  });
});
