import type { Pod } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { observeArtifactResume } from './artifact-resume-observation.js';
import type { StoredEvent } from './event-repository.js';

const failure =
  'Artifact preservation failed. Original container retained; retry collection before completing.';
const settledAt = '2026-10-10T21:05:46.000Z';
function pod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'retained',
    status: 'failed',
    lifecycleGeneration: 1,
    containerId: 'same-source',
    profileName: 'original',
    runtime: 'claude',
    model: 'original-model',
    providerAccountIdSnapshot: 'original-account',
    options: { output: 'artifact' },
    pendingEscalation: null,
    failureReason: failure,
    updatedAt: '2026-10-10T21:52:00.952Z',
    finalization: {
      generation: 1,
      cycle: 1,
      phase: 'preserving',
      agentSettledAt: settledAt,
      pendingDecisionId: null,
      sourcePreservedAt: null,
    },
    ...overrides,
  } as Pod;
}
function event(
  id: number,
  type: 'status' | 'error',
  message: string,
  timestamp = '2026-10-10T21:52:00.900Z',
): StoredEvent {
  return {
    id,
    podId: 'retained',
    type: 'pod.agent_activity',
    createdAt: timestamp,
    payload: {
      type: 'pod.agent_activity',
      podId: 'retained',
      timestamp,
      event:
        type === 'error'
          ? { type, timestamp, message, fatal: false }
          : { type, timestamp, message },
    },
  };
}
const events = () => [
  event(1, 'error', failure, '2026-10-10T21:07:00.000Z'),
  event(2, 'status', 'Resume: retrying artifact collection from the settled worker…'),
  event(3, 'status', 'Collecting artifacts…'),
  event(4, 'error', failure),
];

describe('read-only settled artifact resume observation', () => {
  it('binds a settled failed operation to durable event identity and the retained source', () => {
    const result = observeArtifactResume(pod(), events(), false);
    expect(result.state).toBe('settled-failed');
    expect(result.binding).toMatchObject({
      podId: 'retained',
      generation: 1,
      cycle: 1,
      containerId: 'same-source',
      agentSettledAt: settledAt,
      profileName: 'original',
    });
    expect(result.operations).toEqual([
      {
        identity: 'retained:1:1:2:4',
        startedEventId: 2,
        failedEventId: 4,
        state: 'failed',
        agentRerun: false,
      },
    ]);
    expect(observeArtifactResume(pod(), JSON.parse(JSON.stringify(events())), false)).toEqual(
      result,
    );
  });
  it('retains distinct operation identities so a caller cannot guess between retries', () => {
    const history = [
      ...events(),
      event(5, 'status', 'Resume: retrying artifact collection from the settled worker…'),
      event(6, 'status', 'Collecting artifacts…'),
      event(7, 'error', failure),
    ];
    expect(observeArtifactResume(pod(), history, false).operations).toHaveLength(2);
  });
  it.each([
    ['active collection', pod(), events(), true],
    ['running pod', pod({ status: 'running' }), events(), false],
    [
      'missing exit gate/current guidance',
      pod({ pendingEscalation: {} as Pod['pendingEscalation'] }),
      events(),
      false,
    ],
    [
      'preserved source',
      pod({ finalization: { ...(pod().finalization ?? {}), sourcePreservedAt: settledAt } }),
      events(),
      false,
    ],
    ['generation drift', pod({ lifecycleGeneration: 2 }), events(), false],
    ['missing failure', pod(), events().slice(0, -1), false],
    ['missing collection', pod(), events().filter((e) => e.id !== 3), false],
    ['no resume', pod(), events().slice(0, 1), false],
    [
      'failure before settlement',
      pod(),
      events().map((e) =>
        event(
          e.id,
          e.payload.type === 'pod.agent_activity' && e.payload.event.type === 'error'
            ? 'error'
            : 'status',
          e.payload.type === 'pod.agent_activity' && 'message' in e.payload.event
            ? e.payload.event.message
            : '',
          '2026-10-10T21:00:00.000Z',
        ),
      ),
      false,
    ],
  ] as const)(
    'refuses %s rather than inventing a completed effect',
    (_label, value, history, active) => {
      expect(observeArtifactResume(value, [...history], active).state).toBe('unavailable');
    },
  );
});
