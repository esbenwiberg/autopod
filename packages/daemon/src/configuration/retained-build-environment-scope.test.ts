import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { EffectiveLaunchConfig } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { checkpointRecoveryRoutes } from '../api/routes/checkpoint-recovery.js';
import { createRetainedCheckpointRecovery } from '../pods/retained-checkpoint-recovery.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { terminationAuth } from '../test-utils/termination-reconciliation-helpers.js';
import { configurationDigest } from './configuration-digest.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from './retained-continuation-launch.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await retainedCheckpointFixture('validation', true, true);
  fixtures.push(f);
  const original = f.ctx.deps.launchConfiguration!.read(f.podId)!;
  const { digest: _digest, ...body } = structuredClone(original);
  if (!body.repository) throw new Error('Repository fixture missing');
  body.repository.setup.buildEnv = { CI: { value: 'true' }, XPM_BICEP: { value: '/pinned/bicep' } };
  body.repository.setup.buildCommand = 'printf "%s" "$XPM_BICEP"';
  const parent: EffectiveLaunchConfig = { ...body, digest: configurationDigest(body) };
  const selection: RetainedExecutionSelection = {
    profileId: 'same-software',
    parentDigest: parent.digest,
    environment: parent.environment,
    resolvedEnvironment: parent.resolvedEnvironment,
    target: parent.execution.target,
    main: parent.resolvedExecution.main,
    resolvedExecution: parent.resolvedExecution,
    digest: '',
  };
  return { f, parent, selection };
}

async function serviceFixture() {
  const f = await retainedCheckpointFixture('validation', true, true, false, 'local', undefined, {
    buildEnv: { CI: { value: 'true' }, XPM_BICEP: { value: '/pinned/bicep' } },
  });
  fixtures.push(f);
  const launch = f.ctx.deps.launchConfiguration!;
  const parent = launch.read(f.podId)!;
  const selection: RetainedExecutionSelection = {
    profileId: 'same-software',
    parentDigest: parent.digest,
    environment: parent.environment,
    resolvedEnvironment: parent.resolvedEnvironment,
    target: parent.execution.target,
    main: parent.resolvedExecution.main,
    resolvedExecution: parent.resolvedExecution,
    digest: '',
  };
  selection.digest = retainedContinuationLaunch(parent, f.podId, selection).digest;
  f.deps.readLaunch = launch.read;
  f.deps.executionSettings = launch.executionSettings;
  f.deps.executionForPod = (pod) => launch.executionSettings(launch.read(pod.id)!);
  f.deps.previewExecution = vi.fn(async () => structuredClone(selection));
  f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
    head: f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: '1'.repeat(40),
  }));
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  return { f, launch, parent, selection };
}

describe('explicit retained build-only environment selection', () => {
  it('transports only explicit scoped keys through strict human preview/admission routes', async () => {
    const { f, selection } = await serviceFixture();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const auth = terminationAuth();
    const validate = auth.validateToken;
    auth.validateToken = async (token) => ({
      ...(await validate(token)),
      oid: 'operator',
      roles: [],
    });
    authPlugin(app, auth);
    checkpointRecoveryRoutes(app, {
      ...f.manager,
      previewRetainedExecution: f.recovery.previewExecution,
      continueRetained: f.recovery.continueRetained,
    });
    const headers = { authorization: 'Bearer human-token' };
    const url = `/pods/${f.podId}/retained-continuation`;
    try {
      for (const keys of ['XPM_BICEP,XPM_BICEP', ';bad', '']) {
        const r = await app.inject({
          method: 'GET',
          url: `${url}/execution?profileId=${selection.profileId}&buildOnlyEnvironmentKeys=${encodeURIComponent(keys)}`,
          headers,
        });
        expect(r.statusCode).toBe(400);
      }
      const preview = await app.inject({
        method: 'GET',
        url: `${url}/execution?profileId=${selection.profileId}&buildOnlyEnvironmentKeys=XPM_BICEP`,
        headers,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().buildOnlyEnvironmentKeys).toEqual(['XPM_BICEP']);
      const input = {
        ...f.input,
        executionProfileId: selection.profileId,
        expectedExecutionDigest: preview.json().digest,
        buildOnlyEnvironmentKeys: ['XPM_BICEP'],
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...input, buildCommand: 'skip tests' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: 'Bearer pod-token' },
            payload: input,
          })
        ).statusCode,
      ).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(
        202,
      );
      await f.recovery.wait(f.input.id);
      expect(f.recovery.list(f.podId)[0]?.blocked).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a scope with no build command or an oversized expanded command', async () => {
    const { f, parent, selection } = await fixture();
    Object.assign(selection, { buildOnlyEnvironmentKeys: ['XPM_BICEP'] });
    parent.repository!.setup.buildCommand = null;
    expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
    parent.repository!.setup.buildCommand = 'x'.repeat(50_000);
    expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
  });

  it('canonicalizes selected keys without mutating the caller or original environment', async () => {
    const { f, parent, selection } = await fixture();
    const keys = ['XPM_BICEP', 'CI'];
    Object.assign(selection, { buildOnlyEnvironmentKeys: keys });
    const first = retainedContinuationLaunch(parent, f.podId, selection);
    Object.assign(selection, { buildOnlyEnvironmentKeys: [...keys].reverse() });
    const second = retainedContinuationLaunch(parent, f.podId, selection);
    expect(first.digest).toBe(second.digest);
    expect(first.repository!.setup.buildEnv).toEqual({});
    expect(keys).toEqual(['XPM_BICEP', 'CI']);
  });
  it('previews, records and replays an owner-selected immutable derived configuration without another worker', async () => {
    const { f, launch, parent, selection } = await serviceFixture();
    const oldResult = structuredClone(f.pod().lastValidationResult);
    const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    const preview = await f.recovery.previewExecution(f.podId, selection.profileId, ['XPM_BICEP']);
    expect(preview.digest).not.toBe(selection.digest);
    const input = {
      ...f.input,
      executionProfileId: selection.profileId,
      expectedExecutionDigest: preview.digest,
      buildOnlyEnvironmentKeys: ['XPM_BICEP'],
    };
    await f.recovery.continueRetained(f.podId, input, f.actor);
    await f.recovery.wait(f.input.id);
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked).toBeNull();
    expect(record.activated).toEqual({ generation: 2 });
    expect(record.binding.continuation?.execution?.buildOnlyEnvironmentKeys).toEqual(['XPM_BICEP']);
    expect(launch.read(f.podId)!.repository!.setup.buildEnv).toEqual({ CI: { value: 'true' } });
    expect(launch.read(f.podId)!.repository!.setup.buildCommand).toContain(
      "env 'XPM_BICEP=/pinned/bicep' /bin/sh -c",
    );
    expect(parent.repository!.setup.buildEnv.XPM_BICEP).toEqual({ value: '/pinned/bicep' });
    expect(record.originalEvidence?.result).toEqual(oldResult);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(
      before.agentRunCount,
    );
    const replay = await f.recovery.continueRetained(f.podId, input, f.actor);
    expect(replay.id).toBe(record.id);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('refuses a stale software-only digest before custody, account changes or dispatch', async () => {
    const { f, selection } = await serviceFixture();
    await expect(
      f.recovery.continueRetained(
        f.podId,
        {
          ...f.input,
          executionProfileId: selection.profileId,
          expectedExecutionDigest: selection.digest,
          buildOnlyEnvironmentKeys: ['XPM_BICEP'],
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'CONTINUATION_EXECUTION_CHANGED' });
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('refuses unrelated humans and rechecks owner identity after provider observation', async () => {
    const { f, selection } = await serviceFixture();
    const preview = await f.recovery.previewExecution(f.podId, selection.profileId, ['XPM_BICEP']);
    const input = {
      ...f.input,
      executionProfileId: selection.profileId,
      expectedExecutionDigest: preview.digest,
      buildOnlyEnvironmentKeys: ['XPM_BICEP'],
    };
    await expect(
      f.recovery.continueRetained(f.podId, input, { type: 'human', userId: 'not-owner' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    vi.mocked(f.cm.getResourceKey!).mockImplementationOnce(async () => {
      f.ctx.db.prepare('UPDATE pods SET user_id=? WHERE id=?').run('new-owner', f.podId);
      return f.resourceKey;
    });
    await expect(f.recovery.continueRetained(f.podId, input, f.actor)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the pinned tool only in the build command without changing source/check/review authority', async () => {
    const { f, parent, selection } = await fixture();
    const before = structuredClone(parent);
    Object.assign(selection, { buildOnlyEnvironmentKeys: ['XPM_BICEP'] });
    const next = retainedContinuationLaunch(parent, f.podId, selection);
    expect(next.repository!.setup.buildEnv).toEqual({ CI: { value: 'true' } });
    expect(
      execFileSync('/bin/sh', ['-c', next.repository!.setup.buildCommand!], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
      }),
    ).toBe('/pinned/bicep');
    expect(next.repository!.setup.testCommand).toBe(parent.repository!.setup.testCommand);
    expect(next.workflow).toEqual(parent.workflow);
    expect(next.ai).toEqual(parent.ai);
    expect(next.work).toEqual(parent.work);
    expect(next.execution.networkPolicy).toEqual(parent.execution.networkPolicy);
    expect(next.resolvedExecution).toEqual(parent.resolvedExecution);
    expect(next.environment).toEqual(parent.environment);
    expect(parent).toEqual(before);
    expect(next.digest).not.toBe(parent.digest);
  });

  it('preserves historical execution preview meaning when no scoping was selected', async () => {
    const { f, parent, selection } = await fixture();
    const next = retainedContinuationLaunch(parent, f.podId, selection);
    expect(next.repository).toEqual(parent.repository);
  });

  it.each(
    [[], ['UNKNOWN'], ['XPM_BICEP', 'XPM_BICEP'], ['XPM_BICEP; echo unsafe'], ['__proto__']].map(
      (keys) => ({ keys }),
    ),
  )('refuses an unavailable or malformed scope $keys', async ({ keys }) => {
    const { f, parent, selection } = await fixture();
    Object.assign(selection, { buildOnlyEnvironmentKeys: keys });
    expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
  });

  it('does not materialize or relocate a secret reference', async () => {
    const { f, parent, selection } = await fixture();
    parent.repository!.setup.buildEnv.XPM_BICEP = { secretId: 'secret-reference' };
    Object.assign(selection, { buildOnlyEnvironmentKeys: ['XPM_BICEP'] });
    expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
  });

  it('quotes the original value and whole build command without shell evaluation', async () => {
    const { f, parent, selection } = await fixture();
    const value = "literal ' $(printf INJECTED); $HOME\nline";
    parent.repository!.setup.buildEnv.XPM_BICEP = { value };
    Object.assign(selection, { buildOnlyEnvironmentKeys: ['XPM_BICEP'] });
    const next = retainedContinuationLaunch(parent, f.podId, selection);
    expect(
      execFileSync('/bin/sh', ['-c', next.repository!.setup.buildCommand!], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
      }),
    ).toBe(value);
  });

  it('binds the scoped selection digest instead of accepting an old software-only preview', async () => {
    const { f, parent, selection } = await fixture();
    selection.digest = retainedContinuationLaunch(parent, f.podId, selection).digest;
    Object.assign(selection, { buildOnlyEnvironmentKeys: ['XPM_BICEP'] });
    expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
  });
});
