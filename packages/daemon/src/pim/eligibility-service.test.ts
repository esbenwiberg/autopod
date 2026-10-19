import type { PimSelection } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { type PimApiClient, createPimApiClient, pimPages } from './api-client.js';
import { createPimEligibilityService } from './eligibility-service.js';
import { createPimPolicyReader, pimMaximumDuration } from './policy-reader.js';

const account = { tenantId: 'tenant', principalId: 'user' };
const dates = { startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' };
function fixture(clock = { now: Date.parse('2026-09-13T00:00:00Z') }) {
  const get = vi.fn(async (_audience: string, path: string): Promise<unknown> => {
    if (path.includes('/me?')) return { id: 'user' };
    if (path.includes('/group/'))
      return {
        value: [
          {
            id: 'group-eligibility',
            principalId: 'user',
            groupId: 'group',
            accessId: 'member',
            eligibilityScheduleId: 'schedule',
            group: { displayName: 'Sandbox users' },
            ...dates,
          },
        ],
      };
    if (path.includes('/directory/'))
      return {
        value: [
          {
            id: 'directory-eligibility',
            principalId: 'user',
            roleDefinitionId: 'role',
            roleEligibilityScheduleId: 'schedule',
            directoryScopeId: '/',
            appScopeId: null,
            roleDefinition: { displayName: 'Reader' },
            ...dates,
          },
        ],
      };
    return {
      value: [
        {
          name: 'azure-eligibility',
          properties: {
            principalId: 'user',
            roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/reader',
            roleEligibilityScheduleId: 'schedule',
            scope: '/subscriptions/sub/resourceGroups/exact',
            ...dates,
          },
        },
      ],
    };
  });
  const client: PimApiClient = { account, get, mutate: vi.fn() };
  const policy = { maximumDurationMinutes: vi.fn(async (_item?: { type: string }) => 60) };
  return {
    client,
    get,
    policy,
    clock,
    service: createPimEligibilityService(client, policy, () => clock.now),
  };
}
describe('PIM discovery', () => {
  it('discovers three distinct role families for the same user without activation', async () => {
    const f = fixture();
    const result = await f.service.discover();
    expect(
      result.families.map((family) => family.available && family.assignments[0]?.type),
    ).toEqual(['group', 'azure-role', 'directory-role']);
    expect(result.families[0]?.assignments[0]).toMatchObject({
      displayName: 'Sandbox users (member)',
      scope: 'group',
      maximumDurationMinutes: 60,
    });
    expect(f.client.mutate).not.toHaveBeenCalled();
    await f.service.discover();
    expect(f.get).toHaveBeenCalledTimes(4);
  });
  it('caches each family on its own clock and lets fresh bypass it', async () => {
    const f = fixture();
    const healthy = f.get.getMockImplementation();
    f.get.mockImplementation(async (audience, path) => {
      if (path.includes('/group/')) throw new Error('403');
      return healthy?.(audience, path);
    });
    const families = () => f.get.mock.calls.filter(([, path]) => !path.includes('/me?')).length;
    const first = await f.service.discover();
    expect(first.families.map((family) => family.available)).toEqual([false, true, true]);
    expect(families()).toBe(3);
    // A refused family must not keep the healthy ones from being served from cache.
    await f.service.discover();
    expect(families()).toBe(3);
    // Past the failed-family TTL only the failed family is re-read; discoveredAt keeps the oldest.
    f.clock.now += 61_000;
    const second = await f.service.discover();
    expect(families()).toBe(4);
    expect(second.discoveredAt).toBe(first.discoveredAt);
    await f.service.discover(true);
    expect(families()).toBe(7);
  });
  it('shares one provider round between concurrent opens', async () => {
    const f = fixture();
    await Promise.all([f.service.discover(), f.service.discover(), f.service.discover()]);
    expect(f.get).toHaveBeenCalledTimes(4);
  });
  it('reads policies in parallel but bounded', async () => {
    const f = fixture();
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `azure-${index}`,
      properties: {
        principalId: 'user',
        roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/r${index}`,
        roleEligibilityScheduleId: 'schedule',
        scope: '/subscriptions/sub',
        ...dates,
      },
    }));
    const healthy = f.get.getMockImplementation();
    f.get.mockImplementation(async (audience, path) =>
      audience === 'arm' ? { value: many } : healthy?.(audience, path),
    );
    let active = 0;
    let peak = 0;
    // The bound is per family; group and directory reads run alongside it.
    f.policy.maximumDurationMinutes.mockImplementation(async (item) => {
      if (item?.type !== 'azure-role') return 60;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return 60;
    });
    const result = await f.service.discover();
    expect(result.families[1]?.assignments).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });
  it('reads each resource policy once per scope and role and never caches a failure', async () => {
    const clock = { now: 0 };
    const get = vi.fn(async (_audience: string, path: string): Promise<unknown> => {
      if (path.includes('roleManagementPolicyAssignments'))
        return {
          value: [
            {
              properties: {
                roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/reader',
                policyId:
                  '/subscriptions/sub/providers/Microsoft.Authorization/roleManagementPolicies/p',
                scope: '/subscriptions/sub',
              },
            },
          ],
        };
      return {
        properties: {
          rules: [
            {
              id: 'Expiration_EndUser_Assignment',
              maximumDuration: 'PT8H',
              target: { caller: 'EndUser', level: 'Assignment' },
            },
          ],
        },
      };
    });
    const reader = createPimPolicyReader({ account, get, mutate: vi.fn() }, () => clock.now);
    const item = {
      ...account,
      type: 'azure-role',
      eligibilityId: 'a',
      roleId: 'reader',
      scope: '/subscriptions/sub',
      displayName: 'Reader',
      scopeName: 'sub',
      startsAt: dates.startDateTime,
      expiresAt: null,
      maximumDurationMinutes: null,
      provider: {
        scheduleId: 'schedule',
        roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/reader',
      },
    } as const;
    await expect(
      Promise.all([
        reader.maximumDurationMinutes(item),
        reader.maximumDurationMinutes({ ...item, eligibilityId: 'b', scope: '/SUBSCRIPTIONS/sub' }),
      ]),
    ).resolves.toEqual([480, 480]);
    expect(get).toHaveBeenCalledTimes(2);
    clock.now += 61 * 60_000;
    get.mockRejectedValueOnce(new Error('outage'));
    await expect(reader.maximumDurationMinutes(item)).rejects.toThrow('outage');
    await expect(reader.maximumDurationMinutes(item)).resolves.toBe(480);
  });
  it('requires the exact eligibility, account, role and scope at activation recheck', async () => {
    const f = fixture();
    const selection: PimSelection = {
      ...account,
      type: 'azure-role',
      eligibilityId: 'azure-eligibility',
      roleId: 'reader',
      scope: '/subscriptions/sub/resourceGroups/exact',
      displayName: 'Reader',
      timing: 'when-needed',
      duration: 'PT1H',
      justification: 'Debug',
    };
    await expect(f.service.selected(selection)).resolves.toMatchObject({
      eligibilityId: 'azure-eligibility',
    });
    await expect(f.service.selected({ ...selection, scope: '/subscriptions/sub' })).rejects.toThrow(
      'Exact',
    );
    await expect(f.service.selected({ ...selection, eligibilityId: 'other' })).rejects.toThrow(
      'Exact',
    );
    await expect(f.service.selected({ ...selection, principalId: 'other' })).rejects.toThrow(
      'different account',
    );
    expect(f.client.mutate).not.toHaveBeenCalled();
  });
  it('keeps unreadable policy explicit and incomplete discovery unavailable', async () => {
    const f = fixture();
    f.policy.maximumDurationMinutes.mockRejectedValue(new Error('No permission'));
    let result = await f.service.discover(true);
    expect(result.families[0]?.assignments[0]).toMatchObject({
      maximumDurationMinutes: null,
      policyUnavailableReason: expect.any(String),
    });
    f.get.mockImplementation(async (_audience, path) =>
      path.includes('/me?')
        ? { id: 'user' }
        : { value: [], '@odata.nextLink': 'https://other.example/steal' },
    );
    result = await f.service.discover(true);
    expect(
      result.families.every((family) => !family.available && family.assignments.length === 0),
    ).toBe(true);
    expect(result.families[0]?.reason).toContain('(PIM_DISCOVERY_INCOMPLETE)');
  });
  it('follows complete pagination and rejects loops or cross-origin links', async () => {
    const f = fixture();
    f.get
      .mockResolvedValueOnce({ value: [1], nextLink: 'https://management.azure.com/next' })
      .mockResolvedValueOnce({ value: [2] });
    expect(await pimPages(f.client, 'arm', '/first')).toEqual([1, 2]);
    f.get.mockResolvedValue({ value: [], nextLink: 'https://management.azure.com/first' });
    await expect(pimPages(f.client, 'arm', '/first')).rejects.toThrow('incomplete');
  });
  it('does not send a token after the configured user changes or across redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const credential = vi.fn(async () => ({ ...account, token: 'fixture-token' }));
    const client = createPimApiClient(account, credential, fetcher);
    await expect(client.get('graph', 'https://other.example/')).rejects.toThrow('Invalid');
    expect(fetcher).not.toHaveBeenCalled();
    credential.mockResolvedValueOnce({
      ...account,
      principalId: 'different',
      token: 'fixture-token',
    });
    await expect(client.get('graph', '/v1.0/me')).rejects.toThrow('account changed');
    expect(fetcher).not.toHaveBeenCalled();
    await client.get('graph', '/v1.0/me');
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ 'Accept-Language': 'en-US' }),
      }),
    );
  });
  it('uses the end-user activation policy, not the admin eligibility duration', () => {
    expect(
      pimMaximumDuration([
        {
          id: 'Expiration_Admin_Eligibility',
          maximumDuration: 'P365D',
          target: { caller: 'Admin', level: 'Eligibility' },
        },
        {
          id: 'Expiration_EndUser_Assignment',
          maximumDuration: 'PT1H30M',
          target: { caller: 'EndUser', level: 'Assignment' },
        },
      ]),
    ).toBe(90);
    expect(() => pimMaximumDuration([])).toThrow('unavailable');
  });
});
