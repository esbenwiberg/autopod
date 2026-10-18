import { describe, expect, it } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { PAUSE_QUIESCENCE_TIMEOUT_MS, createOperatorPauseState } from './operator-state.js';
describe('single pause-intent owner', () => {
  it('allocates per-instance state shared with all operator consumers', () => {
    const f = createOperatorFixture();
    const second = createOperatorPauseState();
    expect(second.pauseIntents).not.toBe(f.state.pauseIntents);
    expect(f.messagesCaptured.pauseIntents).toBe(f.state.pauseIntents);
    expect(f.pauseCaptured.pauseIntents).toBe(f.state.pauseIntents);
    f.state.pauseIntents.set('prepare', Symbol('pause'));
    expect(f.messagesCaptured.pauseIntents.has('prepare')).toBe(true);
    expect(PAUSE_QUIESCENCE_TIMEOUT_MS).toBe(10_000);
  });
});
