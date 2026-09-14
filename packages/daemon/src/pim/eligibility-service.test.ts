import type { PimSelection } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { type PimApiClient, createPimApiClient, pimPages } from './api-client.js';
import { createPimEligibilityService } from './eligibility-service.js';
import { pimMaximumDuration } from './policy-reader.js';

const account = { tenantId: 'tenant', principalId: 'user' };
const dates = { startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' };
function fixture() {
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
  const policy = { maximumDurationMinutes: vi.fn(async () => 60) };
  return {
    client,
    get,
    policy,
    service: createPimEligibilityService(client, policy, () => Date.parse('2026-09-13T00:00:00Z')),
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
      expect.objectContaining({ redirect: 'error' }),
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
