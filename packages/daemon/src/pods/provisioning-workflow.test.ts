import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { AGENT_ENV_PATH, AGENT_SHIM_PATH } from './provisioning-runtime-files.js';
const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
function fixture(disk = false) {
  const f = createProvisioningFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});
describe('provisioning workflow', () => {
  it('prepares the complete execution context with original object references and no agent dispatch', async () => {
    const f = fixture();
    const owner = f.workflow();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    const result = await owner.preparePodExecution(f.input());
    if (result.kind !== 'ready') throw new Error('Unexpected halt');
    expect(result.prepared.containerManager).toBe(f.cm);
    expect(result.prepared.pod).toMatchObject({
      status: 'running',
      containerId: 'container-123',
      providerAccountIdSnapshot: 'account',
    });
    expect(result.prepared).toMatchObject({
      containerId: 'container-123',
      isRecovery: false,
      isRework: false,
      isFreshContainerValidationOnly: false,
      reasoningEffort: 'auto',
    });
    expect(result.prepared.mcpServers[0]).toMatchObject({
      type: 'http',
      name: 'escalation',
      url: `${f.deps.mcpBaseUrl}/mcp/prepare`,
    });
    expect(result.prepared.systemInstructions).toContain('Original task');
    expect(f.effects.filter((s) => s === 'provisioning' || s === 'running')).toEqual([
      'provisioning',
      'running',
    ]);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(vi.mocked(f.cm.writeFile).mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([AGENT_ENV_PATH, AGENT_SHIM_PATH]),
    );
  });
  it('halts interactive setup before automatic credentials or dispatch material', async () => {
    const f = fixture();
    f.podRepo.update('prepare', {
      options: {
        ...f.pod().options,
        agentMode: 'interactive',
        output: 'branch',
        validate: false,
        promotable: true,
      },
    });
    expect(await f.workflow().preparePodExecution(f.input())).toEqual({ kind: 'halted' });
    expect(f.pod()).toMatchObject({ status: 'running', containerId: 'container-123' });
    expect(f.run.finishStartup).toHaveBeenCalledExactlyOnceWith('pass');
    const paths = vi.mocked(f.cm.writeFile).mock.calls.map((call) => call[1]);
    expect(paths).toContain('/workspace/.mcp.json');
    expect(paths).not.toContain(AGENT_ENV_PATH);
    expect(paths).not.toContain(AGENT_SHIM_PATH);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('retains failed human handoff and halts before container creation', async () => {
    const f = fixture();
    f.podRepo.update('prepare', {
      status: 'handoff',
      containerId: 'human-container',
      worktreePath: f.directory,
    });
    vi.mocked(f.captured.syncWorkspaceBack).mockRejectedValueOnce(new Error('Unproven sync'));
    expect(await f.workflow().preparePodExecution(f.input())).toEqual({ kind: 'halted' });
    expect(f.pod()).toMatchObject({
      status: 'failed',
      containerId: 'human-container',
      options: { agentMode: 'interactive' },
    });
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('retains prepared binding and profile snapshot across private SQLite close/reopen', async () => {
    const f = fixture(true);
    const profile = f.profiles.get('test-profile');
    const result = await f.workflow().preparePodExecution(f.input());
    expect(result.kind).toBe('ready');
    const pod = f.pod();
    const accounts = f.accounts.list();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(next.accounts.list()).toEqual(accounts);
  });
  it('settles a thrown startup through the original public catch/finally and persists the admission', async () => {
    const f = fixture(true);
    f.profiles.update('test-profile', {
      executionTarget: 'sandbox',
      warmImageTag: 'example.azurecr.io/autopod/test:latest',
    });
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    vi.mocked(f.cm.spawn).mockRejectedValueOnce(new Error('Synthetic spawn failure'));
    await f.manager().processPod('prepare');
    const before = f.podRepo.sandboxStartupRetries?.state('prepare');
    expect(before).toMatchObject({ executedCount: 1, latest: { outcome: 'nonretryable' } });
    expect(f.pod().status).toBe('failed');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.sandboxStartupRetries?.state('prepare')).toEqual(before);
    expect(next.pods.getOrThrow('prepare').status).toBe('failed');
  });
  it('persists interactive preparation without inventing an agent execution through file reopen', async () => {
    const f = fixture(true);
    f.podRepo.update('prepare', {
      options: {
        ...f.pod().options,
        agentMode: 'interactive',
        output: 'branch',
        validate: false,
        promotable: true,
      },
    });
    expect(await f.workflow().preparePodExecution(f.input())).toEqual({ kind: 'halted' });
    const pod = f.pod();
    const before = f.podRepo.taskExecutions?.snapshot('prepare');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.pods.taskExecutions?.snapshot('prepare')).toEqual(before);
    expect(before?.agentRunCount).toBe(0);
  });
});
