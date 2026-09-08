import { expect, it, vi } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { ManagedControls } from './managed-controls.js';

it('status is passive, events retain IDs across restart, and stop is not observed termination', async () => {
  const f = fixture();
  try {
    let service = f.service();
    let controls = new ManagedControls(service);
    const handle = await service.start('installation-one', f.request);
    const observe = vi.spyOn(f.runtime, 'observe');
    const first = controls.observe('installation-one', handle.podId, '0');
    expect(first.events.map((event) => event.kind)).toEqual(['queued', 'running']);
    expect(observe).not.toHaveBeenCalled();
    const request = {
      schemaVersion: 1,
      dispatcherAttemptId: f.request.dispatcherAttemptId,
      grantId: f.request.effectiveGrant.grantId,
      grantRevision: 1,
      operation: 'stop',
    };
    const result = await controls.control('installation-one', handle.podId, request, 'stop-one');
    expect(result.stopRequested).toBe(true);
    expect(result.observedExit).toBe(false);
    f.restart();
    service = f.service();
    controls = new ManagedControls(service);
    expect(controls.observe('installation-one', handle.podId, '0').events.slice(0, 2)).toEqual(
      first.events,
    );
    await service.enforceExpiry();
    const last = controls.observe('installation-one', handle.podId, first.cursor);
    expect(last.result.observedExit).toBe(true);
    expect(last.events.map((event) => event.kind)).toEqual(['killing', 'killed']);
  } finally {
    f.close();
  }
});
it('revocation is durable before runtime acknowledgement and delayed controls cannot restore it', async () => {
  const f = fixture();
  try {
    const service = f.service();
    let controls = new ManagedControls(service);
    const handle = await service.start('installation-one', f.request);
    f.runtime.stop = async () => {
      expect(service.row('installation-one', handle.podId).revoked).toBe(1);
      throw new Error('runtime-unavailable');
    };
    const request = {
      schemaVersion: 1,
      dispatcherAttemptId: f.request.dispatcherAttemptId,
      grantId: f.request.effectiveGrant.grantId,
      grantRevision: 1,
      operation: 'revoke',
    };
    expect(
      (await controls.control('installation-one', handle.podId, request, 'revoke-one')).revoked,
    ).toBe(true);
    f.restart();
    controls = new ManagedControls(f.service());
    expect(
      (await controls.control('installation-one', handle.podId, request, 'revoke-one')).revoked,
    ).toBe(true);
    await expect(
      controls.send(
        'installation-one',
        handle.podId,
        {
          schemaVersion: 1,
          dispatcherAttemptId: request.dispatcherAttemptId,
          grantId: request.grantId,
          grantRevision: 1,
          message: 'continue',
        },
        'late',
      ),
    ).rejects.toThrow('inactive');
    const grant = { ...f.request.effectiveGrant, revision: 2 };
    grant.digest = digest(
      Object.fromEntries(Object.entries(grant).filter(([key]) => key !== 'digest')),
    );
    expect(() => controls.updateGrant('installation-one', handle.podId, grant)).toThrow('inactive');
    await expect(
      controls.control(
        'installation-one',
        handle.podId,
        { ...request, operation: 'stop' },
        'revoke-one',
      ),
    ).rejects.toThrow('conflict');
  } finally {
    f.close();
  }
});
it('follow-ups deduplicate and stale revisions fail before the gateway', async () => {
  const f = fixture();
  try {
    const delivered = new Set<string>();
    f.runtime.send = async (_ref, _message, key) => {
      delivered.add(key);
    };
    const s = f.service();
    let controls = new ManagedControls(s);
    const handle = await s.start('installation-one', f.request);
    const message = {
      schemaVersion: 1,
      dispatcherAttemptId: f.request.dispatcherAttemptId,
      grantId: f.request.effectiveGrant.grantId,
      grantRevision: 1,
      message: 'continue within scope',
    };
    await controls.send('installation-one', handle.podId, message, 'follow-one');
    f.restart();
    controls = new ManagedControls(f.service());
    await controls.send('installation-one', handle.podId, message, 'follow-one');
    expect(delivered.size).toBe(1);
    const grant = { ...f.request.effectiveGrant, revision: 2 };
    grant.digest = digest(
      Object.fromEntries(Object.entries(grant).filter(([key]) => key !== 'digest')),
    );
    controls.updateGrant('installation-one', handle.podId, grant);
    expect(() => controls.updateGrant('installation-one', handle.podId, grant)).toThrow('stale');
    await expect(controls.send('installation-one', handle.podId, message, 'late')).rejects.toThrow(
      'stale',
    );
    expect(delivered.size).toBe(1);
  } finally {
    f.close();
  }
});
it('cleanup requires observed exit and committed required artifacts, then retries only cleanup', async () => {
  const f = fixture();
  try {
    const service = f.service();
    const controls = new ManagedControls(service);
    const handle = await service.start('installation-one', f.request);
    const request = {
      schemaVersion: 1,
      dispatcherAttemptId: f.request.dispatcherAttemptId,
      grantId: f.request.effectiveGrant.grantId,
      grantRevision: 1,
      operation: 'cleanup',
    };
    let cleanups = 0;
    f.runtime.cleanup = async () => ++cleanups > 1;
    await expect(
      controls.control('installation-one', handle.podId, request, 'cleanup'),
    ).rejects.toThrow('before-exit');
    await controls.control(
      'installation-one',
      handle.podId,
      { ...request, operation: 'stop' },
      'stop',
    );
    await service.enforceExpiry();
    await expect(
      controls.control('installation-one', handle.podId, request, 'cleanup'),
    ).rejects.toThrow('export-pending');
    expect(cleanups).toBe(0);
    // Simulate a committed receipt at the artifact store boundary, not a provider effect.
    service.db
      .prepare(`INSERT INTO artifact_exports (artifact_id,pod_id,dispatcher_attempt_id,execution_spec_digest,status,
      manifest_json,manifest_sha256,bundle_sha256,bundle_bytes,blob_manifest_name,blob_bundle_name,file_count,total_bytes,created_at)
      VALUES ('fixture',?,?,?,'committed','{}','fixture','fixture',x'00','fixture','fixture',1,1,1)`)
      .run(handle.podId, handle.dispatcherAttemptId, handle.acceptedExecutionSpecDigest);
    expect(
      (await controls.control('installation-one', handle.podId, request, 'cleanup')).cleanup,
    ).toBe('requested');
    expect(
      (await controls.control('installation-one', handle.podId, request, 'cleanup')).cleanup,
    ).toBe('observed');
    expect(
      (await controls.control('installation-one', handle.podId, request, 'cleanup')).cleanup,
    ).toBe('observed');
    expect(cleanups).toBe(2);
  } finally {
    f.close();
  }
});
