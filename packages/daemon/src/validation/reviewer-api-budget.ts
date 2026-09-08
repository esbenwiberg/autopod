/** A local deadline does not attest to credential-provider or remote request cancellation. */
export class ReviewerApiDeadlineError extends Error {
  constructor(stage: string) {
    super(
      `Selected reviewer ${stage} deadline exhausted; reconcile before retry. No automatic replay was admitted.`,
    );
  }
}

export function reviewerApiBudget(timeout: number) {
  const deadline = performance.now() + timeout;
  const remaining = (stage = 'API dispatch') => {
    const value = Math.floor(deadline - performance.now());
    if (!Number.isFinite(timeout) || timeout <= 0 || value <= 0)
      throw new ReviewerApiDeadlineError(stage);
    return value;
  };
  return {
    remaining,
    async acquire<T>(factory: () => Promise<T>): Promise<T> {
      const milliseconds = remaining('client acquisition');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          factory(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ReviewerApiDeadlineError('client acquisition')),
              milliseconds,
            );
          }),
        ]);
        remaining('client acquisition');
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
