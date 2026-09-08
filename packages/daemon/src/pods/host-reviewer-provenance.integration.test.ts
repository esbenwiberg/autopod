import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

it('records the actual host CLI before its dispatch and rejects stale manager replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-host-receipt-'));
  const command = path.join(directory, 'claude');
  const dispatchFile = path.join(directory, 'dispatch.txt');
  await fs.writeFile(
    command,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo probe >> probes.txt; echo "2.9.1 (fixture)"; exit 0; fi\necho dispatched > dispatch.txt\necho fixture-verdict\n',
    { mode: 0o700 },
  );
  const ctx = createTestContext();
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Inspect actual host reviewer' },
    'human',
  );
  ctx.podRepo.update(pod.id, {
    status: 'running',
    containerId: 'retained-container',
    worktreePath: directory,
  });
  let captured: ValidationEngineConfig | undefined;
  let proved = false;
  vi.mocked(ctx.validationEngine.validate).mockImplementation(async (config) => {
    captured = config;
    expect(config.recordHostReviewerDispatch).toBeTypeOf('function');
    expect(() =>
      config.recordHostReviewerDispatch?.({
        model: 'wrong-model',
        cliPath: command,
        cliVersion: '2.9.1',
        status: 'checked',
      }),
    ).toThrow(/model/i);
    const result = await runClaudeCli({
      model: config.reviewerModel ?? 'auto',
      input: 'review',
      timeout: 2000,
      command,
      spawnOptions: { cwd: directory },
      beforeSpawn: config.assertReviewerCurrent,
      recordHostDispatch: (evidence) => {
        config.recordHostReviewerDispatch?.(evidence);
        expect(existsSync(dispatchFile)).toBe(false);
        expect(ctx.podRepo.executionProvenance?.latest(pod.id)).toMatchObject({
          version: 2,
          surface: 'host-cli',
          purpose: 'review',
          subject: 'reviewer',
          runtime: 'claude',
          cliVersion: '2.9.1',
          status: 'checked',
          providerId: null,
          providerAccountId: null,
          imageDigest: null,
        });
        proved = true;
      },
    });
    expect(result.stdout.trim()).toBe('fixture-verdict');
    ctx.podRepo.update(pod.id, { status: 'running', containerId: 'replacement-container' });
    return createPassingValidationResult(pod.id, config.attempt);
  });
  try {
    await manager.triggerValidation(pod.id);
    expect(proved).toBe(true);
    expect(captured).toBeDefined();
    await expect(
      runClaudeCli({
        model: captured?.reviewerModel ?? 'auto',
        input: 'stale',
        timeout: 1000,
        command,
        spawnOptions: { cwd: directory },
        beforeSpawn: captured?.assertReviewerCurrent,
        recordHostDispatch: captured?.recordHostReviewerDispatch,
      }),
    ).rejects.toThrow(/superseded/i);
    expect(await fs.readFile(path.join(directory, 'probes.txt'), 'utf8')).toBe('probe\n');
    expect(await fs.readFile(dispatchFile, 'utf8')).toBe('dispatched\n');
    expect(ctx.runtime.resume).not.toHaveBeenCalled();
  } finally {
    ctx.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
