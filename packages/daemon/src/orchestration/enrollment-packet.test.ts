import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { digest } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { offlineController } from '../test-utils/offline-controller.js';
import { operatorSeedFixture } from '../test-utils/operator-seed-fixture.js';
import {
  assembleInspection,
  checkInspectionDraft,
  evaluatorStatement,
  signingPacket,
} from './enrollment-packet.js';
import { composeOperatorEnrollment, operatorDraftSchema } from './operator-enrollment.js';

it('checks the real Git bundle and composes independently signed test receipts only for the exact isolated sandbox policy', async () => {
  const { enrollment, cli, profiles, source, f } = await operatorSeedFixture(
    'example.invalid/test@sha256:' + 'b'.repeat(64),
    true,
    'sandbox',
  );
  const { checks: _c, review: _r, authorities: _a, ...draft } = enrollment;
  draft.main = {
    profileName: 'repofit',
    profileId: 'profile-f3ec3b28e6369a8879e2a1da',
    profileRevision: 2,
    aiId: 'ai-2aa5da9e201c0adf52150c71',
    aiRevision: 8,
    model: 'claude-sonnet-5-5',
    accountId: 'anth-pro',
  };
  const b = await readFile(source.bundlePath);
  const pre = (raw: unknown, bytes = b) =>
    checkInspectionDraft(raw, JSON.stringify(profiles), JSON.stringify(cli), bytes);
  expect(operatorDraftSchema.safeParse(enrollment).success).toBe(false);
  await expect(pre(draft, Buffer.from('oops'))).rejects.toThrow('bundle-mismatch');
  await expect(
    pre({ ...draft, source: { ...draft.source, tree: 'f'.repeat(40) } }),
  ).rejects.toThrow('checkpoint-source-mismatch');
  await expect(pre({ ...draft, budget: { ...draft.budget, requests: 19 } })).rejects.toThrow(
    'run-scope',
  );
  const checked = await pre(draft);
  const c = fixtureSigner('checks', 'check-only', digest('pol1')),
    r = fixtureSigner('independentReview', 'review-only', digest('pol2'));
  expect(() =>
    signingPacket(checked, { checks: c.authority, independentReview: c.authority }),
  ).toThrow();
  const pins = { checks: c.authority, independentReview: r.authority },
    p = signingPacket(checked, pins);
  const evidence = (role: string) =>
    Buffer.from(
      JSON.stringify({
        role,
        inputDigest: p.inputDigest,
        status: 'passed',
        findings: 'offline test evidence',
      }),
    );
  expect(() => evaluatorStatement(p, 'checks', evidence('independentReview'))).toThrow();
  const c1 = c.attest(evaluatorStatement(p, 'checks', evidence('checks')).statement);
  const r1 = r.attest(
    evaluatorStatement(p, 'independentReview', evidence('independentReview')).statement,
  );
  expect(() => assembleInspection(p, c1, c1)).toThrow('independentReview-required');
  const changed = signingPacket(await pre({ ...draft, mission: draft.mission + ' changed' }), pins);
  expect(() => assembleInspection(changed, c1, r1)).toThrow('checks-required');
  const e = assembleInspection(p, c1, r1);
  const resume = vi.fn(async () => {});
  const provider = offlineController(() => {
    throw new Error('no external calls');
  });
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    isolatedArtifacts: true,
    profiles,
    cli,
    bind: () => provider.provider,
    runtime: { config: { db: f.db }, resume } as unknown as NonNullable<
      Parameters<typeof composeOperatorEnrollment>[1]['runtime']
    >,
  };
  await composeOperatorEnrollment(e, deps).prepare!();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(provider.calls()).toBe(0);
});

it('preflights a distinct parent draft and binds evaluator signatures to its future launch', async () => {
  const { enrollment, cli, profiles, source } = await operatorSeedFixture(
    `example.invalid/parent-worker@sha256:${'b'.repeat(64)}`,
    true,
    'sandbox',
  );
  const draft = Object.fromEntries(
    Object.entries(enrollment).filter(
      ([key]) => !['authorities', 'checks', 'review'].includes(key),
    ),
  );
  const parent = {
    requestId: '5ecff8d3-de82-48cb-961a-dc06dc506533',
    launchDigest: 'a'.repeat(64),
  };
  const preflight = (selection = parent) =>
    checkInspectionDraft(
      { ...draft, slot: 'new-parent', parent: selection },
      JSON.stringify(profiles),
      JSON.stringify(cli),
      readBundle,
    );
  const readBundle = await readFile(source.bundlePath);
  const checked = await preflight();
  const checks = fixtureSigner('checks', 'parent-checker', digest('checks'));
  const review = fixtureSigner('independentReview', 'parent-reviewer', digest('review'));
  const pins = { checks: checks.authority, independentReview: review.authority };
  const packet = signingPacket(checked, pins);
  const receipt = (role: 'checks' | 'independentReview') => ({
    inputDigest: packet.inputDigest,
    status: 'passed' as const,
    evidenceDigest: digest(role),
  });
  const c = checks.attest(receipt('checks')),
    r = review.attest(receipt('independentReview'));
  expect(assembleInspection(packet, c, r)?.parent).toEqual(parent);
  const changed = signingPacket(await preflight({ ...parent, launchDigest: 'b'.repeat(64) }), pins);
  expect(() => assembleInspection(changed, c, r)).toThrow('checks-required');
});
