import { AutopodError } from '@autopod/shared';

export interface DeletionCleanupStep {
  name: string;
  run(assertCurrent: () => void): Promise<void>;
}

/** A timeout stops admission of later steps; it cannot undo an in-flight backend call. */
export async function runDeletionCleanup(
  steps: DeletionCleanupStep[],
  assertOwnership: () => void,
  timeoutMs = 25_000,
): Promise<void> {
  let active = true;
  let stepName = 'admission';
  const deadline = performance.now() + timeoutMs;
  const failure = () =>
    new AutopodError(
      `Pod deletion cleanup is unverified at ${stepName}. Delete was not completed by this cleanup; reconcile resource and pod state before retrying.`,
      'POD_DELETE_CLEANUP_UNVERIFIED',
      409,
    );
  const assertCurrent = () => {
    if (!active || performance.now() >= deadline) throw failure();
    assertOwnership();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      for (const step of steps) {
        stepName = step.name;
        assertCurrent();
        await step.run(assertCurrent);
        assertCurrent();
      }
    })();
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(failure());
        }, timeoutMs);
      }),
    ]);
  } catch {
    // Backend errors can contain credentials or raw transport bodies. The public
    // action reports the owned stage, never that unbounded backend payload.
    throw failure();
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
  }
}
