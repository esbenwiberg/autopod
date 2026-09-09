import { afterEach, expect, it, vi } from 'vitest';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { ManagedGitHubReadGateway } from './github-read-gateway.js';

let close: (() => void) | undefined;
async function setup() {
  const f = fixture();
  close = f.close;
  const binding = { alias: 'portfolio-issues', bindingDigest: `sha256:${'a'.repeat(64)}` };
  for (const scope of [f.request.profileSnapshot.scope, f.request.effectiveGrant.scope]) {
    scope.identityBindings = [binding];
    scope.allowedEffects.push('github.issue.read');
  }
  f.request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(f.request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
    ),
  );
  f.request.effectiveGrant.profileSnapshotDigest = f.request.profileSnapshot.snapshotDigest;
  resign(f.request);
  f.admission.profiles = new Map([
    [f.request.profileSnapshot.snapshotDigest, f.request.profileSnapshot],
  ]);
  f.admission.enrollmentCeiling = f.request.profileSnapshot.scope;
  f.admission.identityCeiling = f.request.profileSnapshot.scope;
  f.admission.backendCeiling = f.request.profileSnapshot.scope;
  const service = f.service();
  const handle = await service.start('installation', f.request);
  const auth = {
    resolveCredential: vi.fn(async () => ({ token: 'host-only', username: 'x-access-token' })),
    getStatus: vi.fn(),
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ number: 42, title: 'Issue' }));
  const gateway = new ManagedGitHubReadGateway(
    service,
    { ...binding, repository: 'context-and/portfolio-simulation' },
    auth,
    fetcher,
  );
  return { f, service, handle, gateway, auth, fetcher };
}
afterEach(() => close?.());

it('binds exact repository reads and replays without resolving credentials twice', async () => {
  const x = await setup();
  const raw = JSON.stringify({
    operation: 'issue-view',
    repository: 'context-and/portfolio-simulation',
    number: 42,
  });
  const first = await x.gateway.invoke('installation', x.handle.podId, 1, 'issue-42', raw);
  const replay = await x.gateway.invoke('installation', x.handle.podId, 1, 'issue-42', raw);
  expect(JSON.parse(first)).toEqual({ number: 42, title: 'Issue' });
  expect(replay).toBe(first);
  expect(x.fetcher).toHaveBeenCalledTimes(1);
  expect(x.auth.resolveCredential).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(x.f.db.prepare('SELECT * FROM managed_github_reads').all())).not.toContain(
    'host-only',
  );
});

it('refuses repository changes, stale grants and revoked replay before GitHub', async () => {
  const x = await setup();
  await expect(
    x.gateway.invoke(
      'installation',
      x.handle.podId,
      1,
      'wrong',
      JSON.stringify({ operation: 'issue-view', repository: 'other/repo', number: 1 }),
    ),
  ).rejects.toThrow('repository-unbound');
  x.f.db.prepare('UPDATE managed_pods SET revoked=1').run();
  await expect(
    x.gateway.invoke(
      'installation',
      x.handle.podId,
      1,
      'issue',
      JSON.stringify({
        operation: 'issue-view',
        repository: 'context-and/portfolio-simulation',
        number: 1,
      }),
    ),
  ).rejects.toThrow();
  expect(x.fetcher).not.toHaveBeenCalled();
});

it('does not commit a response after revocation during the host read', async () => {
  const x = await setup();
  x.fetcher.mockImplementationOnce(async () => {
    x.f.db.prepare('UPDATE managed_pods SET revoked=1').run();
    return Response.json({ number: 42 });
  });
  await expect(
    x.gateway.invoke(
      'installation',
      x.handle.podId,
      1,
      'issue-42',
      JSON.stringify({
        operation: 'issue-view',
        repository: 'context-and/portfolio-simulation',
        number: 42,
      }),
    ),
  ).rejects.toThrow();
  expect(x.f.db.prepare('SELECT response_json FROM managed_github_reads').get()).toEqual({
    response_json: null,
  });
});

it('bounds a GitHub response even when content-length is absent', async () => {
  const x = await setup();
  x.fetcher.mockResolvedValueOnce(
    new Response(new Uint8Array(1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(
    x.gateway.invoke(
      'installation',
      x.handle.podId,
      1,
      'issue-42',
      JSON.stringify({
        operation: 'issue-view',
        repository: 'context-and/portfolio-simulation',
        number: 42,
      }),
    ),
  ).rejects.toThrow('response-too-large');
});
