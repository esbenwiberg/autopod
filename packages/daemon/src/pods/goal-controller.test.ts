import type { NativeGoalObservation, PodGoal } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { NativeGoalSession } from '../interfaces/native-goal.js';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { GoalController } from './goal-controller.js';
import { createGoalRepository } from './goal-repository.js';

function observation(
  sequence: number,
  state: NativeGoalObservation['state'] = 'active',
): NativeGoalObservation {
  return {
    sequence,
    state,
    objective: 'Tests pass',
    nativeSessionId: 'native',
    nativeStatus: state,
    cumulativeTokens: sequence * 10,
    cumulativeSeconds: sequence,
  };
}
function session(events = [observation(2), observation(3, 'achieved')]): NativeGoalSession {
  return {
    runtime: 'codex',
    open: vi.fn(async () => 'native'),
    get: vi.fn(async () => null),
    start: vi.fn(async () => observation(1)),
    resume: vi.fn(async () => observation(1)),
    pause: vi.fn(async () => observation(4, 'paused')),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    async *observations() {
      for (const event of events) yield event;
    },
  };
}
function fixture() {
  const db = createTestDb();
  insertConfigurationTestPod(db, 'pod');
  const repository = createGoalRepository(db);
  const goal = repository.create('pod', 'Tests pass', 'codex');
  const hooks = {
    assertCurrent: vi.fn(),
    account: vi.fn((_goal: PodGoal): number | null => 1000),
    publish: vi.fn(),
  };
  return {
    db,
    repository,
    goal,
    hooks,
    controller: new GoalController(repository, hooks),
    fence: { generation: 1, attemptId: 'first' },
  };
}

describe('native Goal controller', () => {
  it('does not allocate or open a native session when the recorded budget is already exhausted', async () => {
    const f = fixture();
    const native = session();
    try {
      f.hooks.account.mockReturnValue(0);
      await expect(f.controller.run('pod', f.goal.revision, f.fence, native)).rejects.toMatchObject(
        { code: 'GOAL_BUDGET_EXHAUSTED' },
      );
      expect(native.open).not.toHaveBeenCalled();
      expect(f.repository.get('pod')).toMatchObject({ executionStopped: true, fence: null });
    } finally {
      f.db.close();
    }
  });
  it.each(['pause', 'cancel'] as const)(
    'settles an active %s without losing the saved native identity',
    async (intent) => {
      const f = fixture();
      let release!: () => void;
      const exited = new Promise<void>((resolve) => {
        release = resolve;
      });
      const native = session();
      native.observations = async function* () {
        await exited;
        yield* [];
      };
      vi.mocked(native.stop).mockImplementation(async () => {
        release();
      });
      try {
        const running = f.controller.run('pod', f.goal.revision, f.fence, native);
        await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
        vi.mocked(native.get).mockResolvedValue(observation(2));
        const latest = f.repository.get('pod');
        if (!latest) throw new Error('Missing fixture Goal');
        const controlled = await f.controller.control('pod', latest.revision, intent);
        expect(controlled).toMatchObject({
          state: intent === 'cancel' ? 'cancelled' : 'paused',
          executionStopped: true,
          nativeSessionId: 'native',
        });
        expect(await running).toMatchObject({ state: controlled.state, executionStopped: true });
        expect(native.stop).toHaveBeenCalledOnce();
        expect(f.repository.canComplete('pod')).toBe(false);
      } finally {
        release();
        f.db.close();
      }
    },
  );
  it('stops at the whole-pod budget and reports exhaustion distinctly from a user pause', async () => {
    const f = fixture();
    const native = session();
    f.hooks.account.mockImplementation((goal) => 20 - goal.observedTokens);
    try {
      const result = await f.controller.run('pod', f.goal.revision, f.fence, native);
      expect(result).toMatchObject({ state: 'budget-exhausted', executionStopped: true });
      expect(native.pause).toHaveBeenCalledOnce();
      expect(native.stop).toHaveBeenCalledOnce();
      expect(f.repository.canComplete('pod')).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('continues across intermediate observations and requires native achievement plus confirmed stop', async () => {
    const f = fixture();
    const native = session();
    try {
      vi.mocked(native.stop).mockImplementation(async () => {
        expect(f.repository.canComplete('pod')).toBe(false);
      });
      const result = await f.controller.run('pod', f.goal.revision, f.fence, native);
      expect(result).toMatchObject({
        state: 'achieved',
        observedTokens: 30,
        executionStopped: true,
      });
      expect(f.repository.canComplete('pod')).toBe(true);
      expect(native.start).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
  it('does not turn a clean stream end into achievement', async () => {
    const f = fixture();
    try {
      const result = await f.controller.run(
        'pod',
        f.goal.revision,
        f.fence,
        session([observation(2)]),
      );
      expect(result).toMatchObject({ state: 'paused', executionStopped: true });
      expect(f.repository.canComplete('pod')).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('leaves uncertain termination fenced and never automatically repeats the launch', async () => {
    const f = fixture();
    const native = session();
    try {
      vi.mocked(native.start).mockRejectedValue(new Error('Response uncertain'));
      vi.mocked(native.stop).mockRejectedValue(new Error('Exit unconfirmed'));
      await expect(f.controller.run('pod', f.goal.revision, f.fence, native)).rejects.toThrow(
        'uncertain',
      );
      const saved = f.repository.get('pod');
      if (!saved) throw new Error('Missing goal');
      expect(saved).toMatchObject({
        executionStopped: false,
        state: 'paused',
        nativeSessionId: 'native',
      });
      await expect(
        f.controller.run('pod', saved.revision, { generation: 1, attemptId: 'next' }, session()),
      ).rejects.toThrow('already executing');
      expect(native.start).toHaveBeenCalledOnce();
      const uncertain = f.repository.get('pod');
      if (!uncertain) throw new Error('Missing goal');
      await expect(f.controller.control('pod', uncertain.revision, 'pause')).rejects.toThrow(
        'Exit unconfirmed',
      );
      vi.mocked(native.stop).mockResolvedValue(undefined);
      const pending = f.repository.get('pod');
      if (!pending) throw new Error('Missing goal');
      const stopped = await f.controller.control('pod', pending.revision, 'pause');
      expect(stopped.executionStopped).toBe(true);
      expect(native.start).toHaveBeenCalledOnce();
      expect(native.resume).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('reconciles a completed native goal after restart without resending its objective', async () => {
    const f = fixture();
    const native = session();
    try {
      f.repository.beginAttempt('pod', f.goal.revision, f.fence, 'codex');
      f.repository.bindSession('pod', f.fence, 'native');
      f.repository.confirmStopped('pod', f.fence);
      const saved = f.repository.get('pod');
      if (!saved) throw new Error('Missing goal');
      const requested = f.repository.requestControl('pod', saved.revision, 'resume');
      vi.mocked(native.get).mockResolvedValue(observation(3, 'achieved'));
      const result = await f.controller.run(
        'pod',
        requested.revision,
        { generation: 2, attemptId: 'recovery' },
        native,
      );
      expect(result.state).toBe('achieved');
      expect(native.start).not.toHaveBeenCalled();
      expect(native.resume).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('persists cancellation before requiring reconciliation of an unobserved process', async () => {
    const f = fixture();
    try {
      f.repository.beginAttempt('pod', f.goal.revision, f.fence, 'codex');
      const current = f.repository.get('pod');
      if (!current) throw new Error('Missing goal');
      await expect(f.controller.control('pod', current.revision, 'cancel')).rejects.toThrow(
        'reconciled',
      );
      expect(f.repository.get('pod')).toMatchObject({
        controlIntent: 'cancel',
        executionStopped: false,
      });
    } finally {
      f.db.close();
    }
  });
  it('retries an uncertain stop after achievement without overwriting the native result', async () => {
    const f = fixture();
    const native = session();
    try {
      vi.mocked(native.stop).mockRejectedValue(new Error('Termination unknown'));
      await expect(f.controller.run('pod', f.goal.revision, f.fence, native)).rejects.toThrow(
        'Termination unknown',
      );
      const saved = f.repository.get('pod');
      if (!saved) throw new Error('Missing Goal');
      expect(saved).toMatchObject({
        state: 'achieved',
        executionStopped: false,
        observedTokens: 30,
      });
      expect(f.repository.canComplete('pod')).toBe(false);
      vi.mocked(native.stop).mockResolvedValue(undefined);
      vi.mocked(native.get).mockResolvedValue(observation(4, 'achieved'));
      const stopped = await f.controller.control('pod', saved.revision, 'pause');
      expect(stopped).toMatchObject({
        state: 'achieved',
        executionStopped: true,
        observedTokens: 40,
      });
      expect(f.repository.canComplete('pod')).toBe(true);
      expect(native.pause).not.toHaveBeenCalled();
      expect(native.clear).not.toHaveBeenCalled();
      expect(native.resume).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
});
