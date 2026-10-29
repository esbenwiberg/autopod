import { describe, expect, it, vi } from 'vitest';
import { createSourceCommandFixture } from '../test-utils/source-command-helpers.js';
import { createSourceAdoptionRepository } from './source-adoption-repository.js';
import { reconcileSourceCommand } from './source-command-runner.js';

describe('source command physical custody', () => {
  it('records original identity before start and observed exit before permitting another step', async () => {
    const s = createSourceCommandFixture();
    await expect(s.run()).resolves.toMatchObject({ exitCode: 0, stdout: 'source output' });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: s.identity,
      exitCode: 0,
      revoked: false,
    });
    expect(() => s.options.journal.assertSettled('source-checks')).not.toThrow();
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_ALREADY_CLAIMED' });
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(1);
  });
  it('awaits deferred native admission after an early stream handle without replay', async () => {
    const s = createSourceCommandFixture();
    let admit = () => {};
    let exit = (_code: number) => {};
    s.handle.exitCode = new Promise<number>((resolve) => {
      exit = resolve;
    });
    vi.mocked(s.cm.execStreaming).mockImplementationOnce(async (_id, _command, options) => {
      admit = () => {
        options?.onProcessCreated?.(s.identity);
        options?.onProcessStarted?.(s.identity);
      };
      return s.handle;
    });
    const outcome = s.run().then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await vi.waitFor(() => expect(s.cm.execStreaming).toHaveBeenCalledTimes(1));
    expect(s.options.journal.get('source-checks', 'apply')?.identity).toBeNull();
    expect(() => admit()).not.toThrow();
    exit(0);
    expect(await outcome).toMatchObject({
      error: null,
      value: { exitCode: 0, stdout: 'source output' },
    });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: s.identity,
      exitCode: 0,
    });
  });
  it('refuses an exited stream without admission rather than accepting its exit as source proof', async () => {
    const s = createSourceCommandFixture();
    vi.mocked(s.cm.execStreaming).mockResolvedValueOnce(s.handle);
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_EXEC_IDENTITY_MISSING' });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: null,
      exitCode: null,
      revoked: true,
    });
    expect(s.handle.kill).toHaveBeenCalledTimes(1);
  });
  it('revokes an early handle still awaiting identity on deadline and rejects late admission', async () => {
    const s = createSourceCommandFixture();
    s.options.timeoutMs = 20;
    s.handle.exitCode = new Promise(() => {});
    let admit = () => {};
    vi.mocked(s.cm.execStreaming).mockImplementationOnce(async (_id, _command, options) => {
      admit = () => {
        options?.onProcessCreated?.(s.identity);
      };
      return s.handle;
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_TIMEOUT' });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: null,
      exitCode: null,
      revoked: true,
    });
    expect(() => admit()).toThrow();
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_ALREADY_CLAIMED' });
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(1);
  });
  it('never falls back to buffered exec or executes on another resource', async () => {
    const s = createSourceCommandFixture();
    s.options.containerManager = { ...s.cm, supportsExecRecovery: false };
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_EXEC_RECOVERY_UNAVAILABLE' });
    expect(s.cm.execStreaming).not.toHaveBeenCalled();
    s.options.containerManager = s.cm;
    s.options.containerId = 'replacement';
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_RESOURCE_MISMATCH' });
    expect(s.cm.execStreaming).not.toHaveBeenCalled();
    expect(s.cm.execInContainer).not.toHaveBeenCalled();
  });
  it('retains dispatched uncertainty on timeout and prevents replay or another command', async () => {
    const s = createSourceCommandFixture();
    s.options.timeoutMs = 20;
    let exit = (_code: number) => {};
    s.handle.exitCode = new Promise<number>((resolve) => {
      exit = resolve;
    });
    s.handle.kill.mockRejectedValue(new Error('Termination unverified'));
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_TIMEOUT' });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: s.identity,
      exitCode: null,
      revoked: false,
    });
    expect(() => s.options.journal.assertSettled('source-checks')).toThrow();
    expect(() =>
      s.options.journal.claim('source-checks', 'next', ['git', 'status'], 'docker', () => {}),
    ).toThrow();
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_ALREADY_CLAIMED' });
    exit(0);
    await vi.waitFor(() =>
      expect(s.options.journal.get('source-checks', 'apply')?.exitCode).toBe(0),
    );
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(1);
  });
  it('revokes only known-unsent work and refuses a late admission callback', async () => {
    const s = createSourceCommandFixture();
    s.options.timeoutMs = 20;
    let late = () => {};
    vi.mocked(s.cm.execStreaming).mockImplementationOnce(
      async (_id, _command, options) =>
        new Promise((_resolve, reject) => {
          late = () => {
            try {
              options?.onProcessCreated?.(s.identity);
            } catch (error) {
              reject(error);
            }
          };
        }),
    );
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_TIMEOUT' });
    expect(s.options.journal.get('source-checks', 'apply')).toMatchObject({
      identity: null,
      exitCode: null,
      revoked: true,
    });
    late();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.options.journal.get('source-checks', 'apply')?.identity).toBeNull();
  });
  it('retains a genuine nonzero exit without inventing success or leaving an active command', async () => {
    const s = createSourceCommandFixture();
    s.handle.exitCode = Promise.resolve(17);
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_FAILED' });
    expect(s.options.journal.get('source-checks', 'apply')?.exitCode).toBe(17);
    expect(() => s.options.journal.assertSettled('source-checks')).not.toThrow();
    expect(() => s.options.journal.exited('source-checks', 'apply', 0)).toThrow();
  });
  it('retains a provider-observed negative signal exit without converting it to success', async () => {
    const s = createSourceCommandFixture();
    s.handle.exitCode = Promise.resolve(-15);
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_FAILED' });
    expect(s.options.journal.get('source-checks', 'apply')?.exitCode).toBe(-15);
    expect(() => s.options.journal.assertSettled('source-checks')).not.toThrow();
  });
  it('keeps an original admitted exec across reopen and reconciles that identity without rerunning Git', async () => {
    const s = createSourceCommandFixture(true);
    s.options.timeoutMs = 20;
    s.handle.exitCode = new Promise(() => {});
    s.handle.kill.mockRejectedValue(new Error('Lost exit'));
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_TIMEOUT' });
    s.source.f.reopen();
    const journal = createSourceAdoptionRepository(s.source.f.db).commands;
    await expect(
      reconcileSourceCommand({
        journal,
        adoptionId: 'source-checks',
        step: 'apply',
        containerManager: s.cm,
        assertCurrent: () => {},
      }),
    ).resolves.toBe(137);
    expect(s.cm.terminateRecordedExec).toHaveBeenCalledWith(s.identity);
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(1);
    expect(journal.get('source-checks', 'apply')?.exitCode).toBe(137);
    expect(() =>
      s.source.f.db
        .prepare("DELETE FROM source_adoption_events WHERE json_extract(event,'$.step')='apply'")
        .run(),
    ).toThrow();
  });
  it('does not complete source custody while an admitted command lacks an exit', () => {
    const s = createSourceCommandFixture();
    s.options.journal.claim('source-checks', 'apply', ['git', 'merge'], 'docker', () => {});
    s.options.journal.admit('source-checks', 'apply', s.identity, () => {});
    expect(() =>
      s.source.journal.advance('source-checks', 'checking', 'checked', {
        validationHash: 'f'.repeat(64),
        validation: 'pass',
      }),
    ).toThrow();
    expect(s.source.journal.get('source-checks')?.stage).toBe('checking');
  });
});
