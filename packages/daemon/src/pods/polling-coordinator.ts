export interface PollOwnership {
  isCurrent(): boolean;
  stop(): void;
}

interface PollRegistration {
  key: string;
  timer: ReturnType<typeof setInterval>;
  run: (ownership: PollOwnership) => Promise<void>;
}

/** One in-process operation per key, including while a stopped owner drains. */
export function createPollingCoordinator(onError: (error: unknown, key: string) => void) {
  const registrations = new Map<string, PollRegistration>();
  const running = new Map<string, Promise<void>>();

  const stop = (key: string, owner?: PollRegistration): void => {
    const current = registrations.get(key);
    if (!current || (owner && current !== owner)) return;
    registrations.delete(key);
    clearInterval(current.timer);
  };

  const tick = (owner: PollRegistration): void => {
    const { key } = owner;
    const isCurrent = () => registrations.get(key) === owner;
    if (!isCurrent() || running.has(key)) return;
    const operation = Promise.resolve()
      .then(async () => {
        if (isCurrent()) await owner.run({ isCurrent, stop: () => stop(key, owner) });
      })
      .catch((error: unknown) => onError(error, key))
      .finally(() => {
        if (running.get(key) === operation) running.delete(key);
        // A replacement waits for the old operation, then starts once. Missed
        // ticks for the same owner do not become a backlog of remote requests.
        const current = registrations.get(key);
        if (current && current !== owner) tick(current);
      });
    running.set(key, operation);
  };

  return {
    start(key: string, intervalMs: number, run: PollRegistration['run']): void {
      stop(key);
      const owner: PollRegistration = {
        key,
        run,
        timer: setInterval(() => tick(owner), intervalMs),
      };
      owner.timer.unref();
      registrations.set(key, owner);
      tick(owner);
    },
    stop: (key: string) => stop(key),
  };
}
