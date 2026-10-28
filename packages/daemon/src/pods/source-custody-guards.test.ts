import { describe, expect, it } from 'vitest';
import { createAdoptedSourceValidationFixture } from '../test-utils/adopted-source-validation-helpers.js';
import { createDeliveryLedger } from './delivery-ledger.js';
import { createSourcePublicationLedger } from './source-publication-ledger.js';

describe('production source custody admissions', () => {
  it('blocks competing epochs, source pointers and validation publication before side effects', () => {
    const s = createAdoptedSourceValidationFixture();
    for (const changes of [
      { containerId: null },
      { lastValidationResult: s.result },
      { status: 'validating' as const },
      { options: { ...s.f.pod().options, validate: false } },
    ])
      expect(() => s.f.podRepo.update(s.id, changes)).toThrow();
    expect(() => s.f.podRepo.incrementLifecycleGeneration(s.id)).toThrow();
    expect(() => s.f.guards.assertExecutionTerminationVerified(s.id)).toThrow();
    expect(() => s.f.podRepo.delete(s.id)).toThrow();
    expect(s.f.podRepo.listReferencedContainerIds()).toContain(s.f.pod().containerId);
  });
  it('grants only private async epoch-scoped metadata authority, never pointer changes, a worker or delivery', async () => {
    const s = createAdoptedSourceValidationFixture();
    const pod = s.f.pod();
    await s.journal.owned('source-checks', async () => {
      await Promise.resolve();
      s.f.podRepo.update(s.id, { lastValidationResult: null });
      expect(() => s.f.podRepo.update(s.id, { containerId: 'replacement' })).toThrow();
      expect(() =>
        s.f.podRepo.taskExecutions?.beginRun(s.id, pod.lifecycleGeneration, 1, {
          runtime: pod.runtime,
          model: pod.model,
          providerAccountId: pod.providerAccountIdSnapshot,
        }),
      ).toThrow();
      expect(() => s.journal.assertDeliveryAllowed(s.id)).toThrow();
      expect(() => s.journal.assertDeletable(s.id)).toThrow();
    });
    expect(() => s.f.podRepo.update(s.id, { lastValidationResult: s.result })).toThrow();
  });
  it('rejects source publication at the actual ledger even for a private source owner', () => {
    const s = createAdoptedSourceValidationFixture();
    s.journal.owned('source-checks', () =>
      expect(() =>
        createSourcePublicationLedger(s.f.db).admit(s.f.pod(), {
          repository: 'https://github.com/org/repo',
          branch: s.f.pod().branch,
          commitSha: 'b'.repeat(40),
          treeSha: 'c'.repeat(40),
          worktreeClean: true,
        }),
      ).toThrow(),
    );
  });
  it('preserves actual delivery uncertainty rather than claiming an old creation was rejected', () => {
    const s = createAdoptedSourceValidationFixture();
    s.f.db
      .prepare(
        "INSERT INTO delivery_intents(id,identity,pod_id,task_id,generation,repository,branch,base_branch,state,created_at,updated_at) SELECT 'unknown','unknown',pod_id,task_id,?,'github.com/org/repo','repair','main','uncertain','now','now' FROM task_executions WHERE pod_id=?",
      )
      .run(s.f.pod().lifecycleGeneration, s.id);
    expect(() => s.journal.assertControlPlaneSettled(s.id)).toThrow();
    expect(createDeliveryLedger(s.f.db).result('unknown')).toBeNull();
  });
  it('projects custody as risky in detail/list without rewriting a historical ready/approval snapshot', () => {
    const s = createAdoptedSourceValidationFixture();
    const ready = {
      version: 1,
      podId: s.id,
      status: 'ready',
      summary: 'Historical ready',
      areas: [],
      findings: [],
      generatedAt: new Date().toISOString(),
      approvedAt: 'historical',
    };
    s.f.db
      .prepare('UPDATE pods SET readiness_review=? WHERE id=?')
      .run(JSON.stringify(ready), s.id);
    expect(s.f.pod().readinessReview).toMatchObject({
      status: 'risky',
      findings: expect.arrayContaining([
        expect.objectContaining({ id: 'source-custody-unreleased' }),
      ]),
    });
    expect(
      s.f.podRepo.listForDisplay?.().find((pod) => pod.id === s.id)?.readinessReview?.status,
    ).toBe('risky');
    const stored = s.f.db.prepare('SELECT readiness_review FROM pods WHERE id=?').get(s.id) as {
      readiness_review: string;
    };
    expect(JSON.parse(stored.readiness_review)).toEqual(ready);
  });
});
