import { describe, expect, it } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';

function fixture(disk = false) {
  const f = createOperatorFixture(disk, 'sandbox');
  const pod = f.pod();
  const ledger = f.podRepo.taskExecutions;
  if (!ledger || !pod.containerId) throw new Error('Missing execution fixture');
  const run = ledger.beginRun('prepare', pod.lifecycleGeneration, pod.finalization?.cycle ?? 0, {
    runtime: pod.runtime,
    model: pod.model,
    providerAccountId: 'account',
    resource: { executionTarget: 'sandbox', containerId: pod.containerId },
  });
  f.podRepo.update('prepare', { containerId: null });
  return { f, ledger, run, original: pod.containerId };
}

describe('historical execution resource retention', () => {
  it('a cleared current pointer cannot orphan an unresolved dispatch-bound resource', () => {
    const { f, ledger, run, original } = fixture(true);
    ledger.retainUnverifiedRun(run);
    expect(f.podRepo.listReferencedContainerIds()).toContain(original);
    expect(f.reopen().pods.listReferencedContainerIds()).toContain(original);
  });
  it('releases an ordinary execution claim only after its recorded completion', () => {
    const { f, ledger, run, original } = fixture();
    expect(f.podRepo.listReferencedContainerIds()).toContain(original);
    ledger.finishRun(run, 'completed', null);
    expect(f.podRepo.listReferencedContainerIds()).not.toContain(original);
  });
});
