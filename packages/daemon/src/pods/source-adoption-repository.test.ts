import { describe, expect, it } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import {
  createSourceAdoptionRepository,
  sourcePodFingerprint,
} from './source-adoption-repository.js';

function fixture() {
  const f = createOperatorFixture(true);
  const repo = createSourceAdoptionRepository(f.db);
  const pod = f.pod();
  const binding = {
    generation: pod.lifecycleGeneration,
    fingerprint: sourcePodFingerprint(pod),
    repository: 'https://github.com/org/repo',
    branch: pod.branch,
    baseBranch: pod.baseBranch ?? 'main',
    containerId: pod.containerId ?? '',
    resourceKey: `local:test-engine:${pod.containerId}`,
    worktreePath: pod.worktreePath ?? '',
    oldHead: 'a'.repeat(40),
    targetHead: 'b'.repeat(40),
  };
  const actor = { type: 'human' as const, userId: 'operator' };
  const claim = () =>
    repo.claim('one', pod.id, binding, actor, 'Validate repaired source', () => {});
  return { f, repo, pod, binding, actor, claim };
}
describe('durable source adoption custody', () => {
  it('coalesces only the exact same request and fences another operation across reopen', () => {
    const f = fixture();
    expect(f.claim()).toMatchObject({ stage: 'claimed', acquired: true });
    expect(f.claim()).toMatchObject({ id: 'one', acquired: false });
    expect(() =>
      f.repo.claim(
        'one',
        f.pod.id,
        { ...f.binding, targetHead: 'c'.repeat(40) },
        f.actor,
        'Validate repaired source',
        () => {},
      ),
    ).toThrow();
    const previousDb = f.f.db;
    f.f.reopen();
    expect(f.f.db).not.toBe(previousDb);
    const next = createSourceAdoptionRepository(f.f.db);
    expect(next.get('one')?.binding).toEqual(f.binding);
    expect(
      next.claim('one', f.pod.id, f.binding, f.actor, 'Validate repaired source', () => {
        throw new Error('Duplicate must not readmit external work');
      }),
    ).toMatchObject({ id: 'one', acquired: false });
    expect(() => next.assertAvailable(f.pod.id)).toThrow();
    expect(() => next.assertAvailable(f.pod.id, 'one')).not.toThrow();
    expect(() =>
      next.claim('two', f.pod.id, f.binding, f.actor, 'Another repaired source', () => {}),
    ).toThrow();
  });
  it('holds original data and delivery even after current pointers are cleared', () => {
    const f = fixture();
    f.claim();
    expect(() => f.f.podRepo.update(f.pod.id, { containerId: null })).toThrow();
    // Out-of-band legacy pointer loss is not admission to release the original resource.
    f.f.db.prepare('UPDATE pods SET container_id=NULL WHERE id=?').run(f.pod.id);
    expect(f.repo.retains(f.binding.containerId)).toBe(true);
    expect(() => f.repo.assertDeletable(f.pod.id)).toThrow();
    expect(() => f.repo.assertDeliveryAllowed(f.pod.id)).toThrow();
  });
  it('requires human authority, without spending or resetting task accounting', () => {
    const f = fixture();
    const before = f.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(f.pod.id);
    expect(() =>
      f.repo.claim(
        'auto',
        f.pod.id,
        f.binding,
        { type: 'automation', id: 'scheduler' },
        'Adopt repaired source',
        () => {},
      ),
    ).toThrow();
    f.claim();
    expect(f.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(f.pod.id)).toEqual(
      before,
    );
    expect(() => f.f.db.prepare("UPDATE source_adoption_events SET event='{}'").run()).toThrow();
    expect(() => f.f.db.prepare('DELETE FROM source_adoption_events').run()).toThrow();
  });
  it('never turns successful checks into implicit release or deletion authority', () => {
    const f = fixture();
    f.claim();
    f.repo.advance('one', 'claimed', 'preserved', {
      preservation: {
        host: '/old-host',
        container: '/old-container',
        bundle: '/old.bundle',
        bundleHash: 'hash',
        tree: 'tree',
      },
    });
    f.repo.advance('one', 'preserved', 'applying', { generation: f.binding.generation + 1 });
    f.repo.advance('one', 'applying', 'adopted');
    f.repo.advance('one', 'adopted', 'checking');
    expect(() => f.repo.advance('one', 'checking', 'checked')).toThrow();
    f.repo.advance('one', 'checking', 'checked', {
      validationHash: 'f'.repeat(64),
      validation: 'pass',
    });
    expect(() => f.repo.assertAvailable(f.pod.id)).not.toThrow();
    expect(() => f.repo.assertDeliveryAllowed(f.pod.id)).toThrow();
    expect(() => f.repo.assertReleasable(f.binding.containerId)).toThrow();
    expect(() => f.repo.fail('one', 'Reinterpret completed evidence')).toThrow();
  });
  it('does not replay or expire an ambiguous in-place mutation', () => {
    const f = fixture();
    f.claim();
    f.repo.advance('one', 'claimed', 'preserved', {
      preservation: {
        host: '/old-host',
        container: '/old-container',
        bundle: '/old.bundle',
        bundleHash: 'hash',
        tree: 'tree',
      },
    });
    f.repo.advance('one', 'preserved', 'applying', { generation: 2 });
    f.repo.fail('one', 'EXEC_EXIT_UNVERIFIED');
    expect(f.claim().stage).toBe('applying');
    expect(() => f.repo.advance('one', 'preserved', 'applying')).toThrow();
    expect(() => f.f.db.prepare('DELETE FROM source_adoptions').run()).toThrow();
    expect(() => f.f.db.prepare("UPDATE source_adoptions SET binding='{}'").run()).toThrow();
    expect(f.repo.get('one')?.error).toBe('EXEC_EXIT_UNVERIFIED');
  });
});
