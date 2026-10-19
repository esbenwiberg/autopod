export const PAUSE_QUIESCENCE_TIMEOUT_MS = 10_000;

export function createOperatorPauseState() {
  const pauseIntents = new Map<string, symbol>();
  return { pauseIntents };
}
