import type Anthropic from '@anthropic-ai/sdk';
import type { MemoryEntry, MemoryUsageEvent, Pod, Profile } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryRepository } from './memory-repository.js';
import { prefilterMemories, selectRelevantMemories } from './memory-selector.js';
import type { MemoryUsageRepository } from './memory-usage-repository.js';

const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as import('pino').Logger;

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    profileName: 'proj',
    task: 'Add authentication token refresh for the CLI',
    model: 'pod-model',
    options: { agentMode: 'auto', output: 'pr' },
    touches: ['packages/cli/src/auth.ts'],
    seriesDescription: null,
    seriesDesign: null,
    contract: null,
    dependsOnPodIds: [],
    ...overrides,
  } as Pod;
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'proj',
    defaultModel: 'default-model',
    reviewerModel: null,
    ...overrides,
  } as Profile;
}

function makeMemory(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem-1',
    scope: 'profile',
    scopeId: 'proj',
    path: '/workflow/auth.md',
    content: 'Authentication token refresh must preserve cached CLI sessions.',
    contentSha256: 'sha',
    rationale: 'Avoid breaking CLI auth.',
    kind: 'workflow',
    tags: ['auth', 'cli'],
    appliesWhen: null,
    avoidWhen: null,
    confidence: 0.9,
    sourceEvidence: [],
    impactSummary: null,
    version: 1,
    approved: true,
    createdByPodId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMemoryRepo(memories: MemoryEntry[]): MemoryRepository {
  return {
    list(scope, scopeId, approvedOnly) {
      return memories.filter(
        (memory) =>
          memory.scope === scope &&
          memory.scopeId === scopeId &&
          (!approvedOnly || memory.approved),
      );
    },
    listByScope: vi.fn(),
    getOrThrow: vi.fn(),
    insert: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    update: vi.fn(),
    updateMetadata: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
  } as unknown as MemoryRepository;
}

function makeUsageRepo(events: Array<Omit<MemoryUsageEvent, 'createdAt'>>): MemoryUsageRepository {
  return {
    record(event) {
      events.push(event);
      return { ...event, createdAt: '2026-01-01T00:00:00Z' };
    },
    listByMemory: vi.fn(),
    listByPod: vi.fn(),
  };
}

function makeAnthropicClient(responseText: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  } as unknown as Anthropic;
}

describe('memory selector', () => {
  it('prefilters profile and pod memories ahead of globals unless globals are strongly relevant', () => {
    const pod = makePod();
    const memories = [
      makeMemory({
        id: 'global-weak',
        scope: 'global',
        scopeId: null,
        path: '/misc/notes.md',
        content: 'Authentication guidance.',
        rationale: null,
        kind: null,
        tags: [],
      }),
      makeMemory({
        id: 'global-strong',
        scope: 'global',
        scopeId: null,
        content: 'Authentication token refresh CLI workflow.',
      }),
      makeMemory({ id: 'profile', scope: 'profile', scopeId: 'proj', content: 'CLI auth flow.' }),
      makeMemory({ id: 'pod', scope: 'pod', scopeId: 'pod-1', content: 'Token refresh details.' }),
    ];

    const selected = prefilterMemories({ pod, memories });

    expect(selected.map((memory) => memory.id)).toContain('global-strong');
    expect(selected.map((memory) => memory.id)).not.toContain('global-weak');
    expect(selected.map((memory) => memory.id)).toEqual(['pod', 'profile', 'global-strong']);
  });

  it('uses reviewer ranking, caps at five, injects content rationale, and records usage rows', async () => {
    const memories = Array.from({ length: 6 }, (_, index) =>
      makeMemory({
        id: `mem-${index}`,
        content: `Authentication token refresh CLI memory ${index}`,
        path: `/workflow/auth-${index}.md`,
      }),
    );
    const usageEvents: Array<Omit<MemoryUsageEvent, 'createdAt'>> = [];
    const selectedIds = ['mem-5', 'mem-4', 'mem-3', 'mem-2', 'mem-1', 'mem-0'];
    const client = makeAnthropicClient(
      JSON.stringify({
        selected: selectedIds.map((id) => ({ id, reason: `${id} matters now` })),
      }),
    );

    const result = await selectRelevantMemories({
      pod: makePod(),
      profile: makeProfile({ reviewerModel: 'reviewer-model' }),
      deps: {
        memoryRepo: makeMemoryRepo(memories),
        usageRepo: makeUsageRepo(usageEvents),
        anthropicClient: client,
        logger,
      },
    });

    expect(result.unavailableReason).toBeNull();
    expect(result.selected.map((entry) => entry.memory.id)).toEqual([
      'mem-5',
      'mem-4',
      'mem-3',
      'mem-2',
      'mem-1',
    ]);
    expect(result.selected[0].relevanceReason).toBe('mem-5 matters now');
    expect(usageEvents).toHaveLength(10);
    expect(usageEvents.filter((event) => event.kind === 'selected')).toHaveLength(5);
    expect(usageEvents.filter((event) => event.kind === 'injected')).toHaveLength(5);
  });

  it('includes pod-scoped memories from dependency pods', async () => {
    const dependencyMemory = makeMemory({
      id: 'parent-memory',
      scope: 'pod',
      scopeId: 'parent-pod',
      content: 'Authentication token refresh CLI parent handoff memory.',
    });

    const result = await selectRelevantMemories({
      pod: makePod({ dependsOnPodIds: ['parent-pod'] }),
      profile: makeProfile(),
      deps: {
        memoryRepo: makeMemoryRepo([dependencyMemory]),
        anthropicClient: makeAnthropicClient(
          JSON.stringify({
            selected: [{ id: 'parent-memory', reason: 'Parent pod memory applies now.' }],
          }),
        ),
        logger,
      },
    });

    expect(result.selected.map((entry) => entry.memory.id)).toEqual(['parent-memory']);
  });

  it('fails soft with deterministic fallback records when reviewer ranking fails', async () => {
    const memories = [
      makeMemory({ id: 'profile', content: 'Authentication token refresh CLI profile memory.' }),
      makeMemory({
        id: 'global',
        scope: 'global',
        scopeId: null,
        content: 'Authentication token refresh CLI global memory.',
      }),
    ];
    const usageEvents: Array<Omit<MemoryUsageEvent, 'createdAt'>> = [];
    const client = makeAnthropicClient('not json');

    const result = await selectRelevantMemories({
      pod: makePod(),
      profile: makeProfile(),
      deps: {
        memoryRepo: makeMemoryRepo(memories),
        usageRepo: makeUsageRepo(usageEvents),
        anthropicClient: client,
        logger,
      },
    });

    expect(result.unavailableReason).toContain('json_parse_failed');
    expect(result.selected.map((entry) => entry.memory.id)).toEqual(['profile', 'global']);
    expect(result.selected[0].relevanceReason).toContain('Reviewer ranking unavailable');
    expect(usageEvents.map((event) => event.kind)).toEqual([
      'selected',
      'injected',
      'selected',
      'injected',
    ]);
  });

  it('skips non-agent pods', async () => {
    const result = await selectRelevantMemories({
      pod: makePod({ options: { agentMode: 'interactive', output: 'branch' } }),
      profile: makeProfile(),
      deps: {
        memoryRepo: makeMemoryRepo([makeMemory({ id: 'mem' })]),
        logger,
      },
    });

    expect(result.selected).toEqual([]);
  });
});
