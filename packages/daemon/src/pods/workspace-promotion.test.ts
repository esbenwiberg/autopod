import { describe, expect, it } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { insertTestProfile } from '../test-utils/mock-helpers.js';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace promotion lifetime', () => {
  it('requires interactive promotability and a meaningful skip-agent target', async () => {
    const f = createWorkspaceFixture();
    await expect(f.promotion().promoteToAuto('prepare', 'pr')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.interactive();
    await expect(
      f.promotion().promoteToAuto('prepare', 'none', { skipAgent: true }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT_MODE' });
    expect(f.common.enqueueSession).not.toHaveBeenCalled();
  });
  it('replaces handoff instructions and preserves the container/worktree for queued handoff', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    f.podRepo.update('prepare', { handoffInstructions: 'Old context' });
    await f
      .promotion()
      .promoteToAuto('prepare', 'branch', { instructions: ' New context ', skipAgent: true });
    expect(f.pod()).toMatchObject({
      status: 'handoff',
      handoffInstructions: 'New context',
      containerId: 'container-123',
      recoveryWorktreePath: f.directory,
      skipAgent: true,
      autoApprove: false,
      options: { agentMode: 'auto', output: 'branch', promotable: false },
    });
    expect(f.common.enqueueSession).toHaveBeenCalledWith('prepare');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('snapshots the selected legacy worker profile and reuses existing instructions when none are supplied', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    insertTestProfile(f.db, { name: 'worker' });
    f.profiles.update('test-profile', { workerProfile: 'worker' });
    f.podRepo.update('prepare', { handoffInstructions: 'Keep existing' });
    await f.promotion().promoteToAuto('prepare', 'pr');
    expect(f.pod().profileSnapshot?.name).toBe('worker');
    expect(f.pod().handoffInstructions).toBe('Keep existing');
    expect(f.pod().options.validate).toBe(true);
  });
  it('refuses frozen handoff without its live configuration capability', async () => {
    const f = createWorkspaceFixture();
    const native = await f.nativeParent();
    f.podRepo.update(native.parent.podId, {
      status: 'running',
      options: { agentMode: 'interactive', output: 'branch', validate: false, promotable: true },
    });
    await expect(f.promotion().promoteToAuto(native.parent.podId, 'branch')).rejects.toMatchObject({
      code: 'CONFIG_EXECUTION_UNAVAILABLE',
    });
    expect(f.common.enqueueSession).not.toHaveBeenCalled();
  });
});
it('prepares an actual frozen worker despite later preset edits and retains pending handoff through SQLite reopen', async () => {
  const f = createWorkspaceFixture(true);
  const owner = f.promotion();
  const native = await f.nativeLaunch(true);
  const id = native.admitted.podId;
  const flow = native.store.get('workflow', 'flow');
  native.store.write({
    kind: 'workflow',
    id: flow.id,
    name: flow.name,
    expectedRevision: flow.revision,
    payload: { ...flow.payload, validationPhases: [] },
  });
  await owner.promoteToAuto(id, 'artifact', { instructions: ' Frozen handoff ', skipAgent: true });
  const saved = f.podRepo.getOrThrow(id);
  const pending = native.snapshots.getPendingWorker(id);
  expect(saved).toMatchObject({
    status: 'handoff',
    containerId: 'native-container',
    skipAgent: true,
    options: { agentMode: 'auto', output: 'artifact', validate: true },
  });
  expect(pending?.workflow.validationPhases).toEqual(['build']);
  expect(pending?.work.handoffInstructions).toBe('Frozen handoff');
  const next = f.reopen();
  expect(next.pods.getOrThrow(id)).toEqual(saved);
  expect(
    createLaunchSnapshotRepository(f.db, createConfigurationStore(f.db)).getPendingWorker(id),
  ).toEqual(pending);
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});
