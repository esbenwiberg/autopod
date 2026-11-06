import type {
  EffectiveLaunchConfig,
  EscalationRequest,
  ExecutionRequirements,
} from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { assertNoInfrastructureBlocker } from './escalation-coordinator.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createSessionBridge, type SessionBridgeDependencies } from './pod-bridge-impl.js';
import { createPodRepository } from './pod-repository.js';

function fixture() {
  const db = createTestDb();
  insertTestProfile(db, { name: 'proj' });
  db.prepare(
    "INSERT INTO pods (id,profile_name,task,status,model,branch,user_id,launch_config_digest) VALUES ('pod','proj','task','running','opus','main','u',?)",
  ).run('a'.repeat(64));
  const podRepo = createPodRepository(db);
  const escalationRepo = createEscalationRepository(db);
  const requirements: ExecutionRequirements = { version: 2, executables: ['jq'] };
  const launch = {
    digest: 'a'.repeat(64),
    work: { contract: { executionRequirements: requirements } },
    workflow: { escalation: null },
  } as EffectiveLaunchConfig;
  const getLaunchConfiguration = vi.fn(() => launch);
  const podManager = {
    touchHeartbeat: vi.fn(),
    getLaunchConfiguration,
  } as unknown as SessionBridgeDependencies['podManager'];
  const stub = {} as never;
  const bridge = createSessionBridge({
    podRepo,
    escalationRepo,
    podManager,
    eventBus: { emit: vi.fn() } as never,
    nudgeRepo: stub,
    profileStore: stub,
    containerManagerFactory: stub,
    pendingRequestsByPod: new Map(),
    logger,
  });
  const report: EscalationRequest = {
    id: 'report',
    podId: 'pod',
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    response: null,
    payload: {
      kind: 'infrastructure',
      owner: 'autopod',
      phase: 'coding',
      requiresResponse: false,
      description: 'Original narrative remains',
      attempted: ['lookup'],
      needs: 'Declared jq',
      prerequisiteBlocker: {
        version: 1,
        kind: 'missing-execution-prerequisites',
        requirementsHash: configurationDigest(requirements),
        launchers: ['jq'],
      },
    },
  };
  return { db, bridge, podRepo, escalationRepo, getLaunchConfiguration, launch, report };
}

describe('daemon typed blocker ingestion', () => {
  it('validates frozen manifest, stamps generation and preserves original narrative without clearing blocker guard', () => {
    const f = fixture();
    try {
      expect(f.bridge.getExecutionPrerequisites?.('pod')).toMatchObject({
        requirementsHash: configurationDigest(f.launch.work.contract?.executionRequirements),
        requirements: { version: 2, executables: ['jq'] },
      });
      Object.assign(f.report.payload, { lifecycleGeneration: 999 });
      f.bridge.createEscalation(f.report);
      const stored = f.escalationRepo.getOrThrow('report');
      expect(stored.payload).toMatchObject({
        ...f.report.payload,
        lifecycleGeneration: f.podRepo.getOrThrow('pod').lifecycleGeneration,
      });
      expect(f.podRepo.hasInfrastructureBlocker('pod')).toBe(true);
      expect(() => assertNoInfrastructureBlocker(f.podRepo, 'pod')).toThrow(
        /Infrastructure remains blocked/,
      );
      f.bridge.createEscalation(f.report); // Exact replay does not manufacture another report or permission.
      expect(f.escalationRepo.listBySession('pod')).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  it.each([
    'unfrozen',
    'hash',
    'membership',
    'builder',
    'proof',
    'root-proof',
    'native',
    'version',
    'phase',
  ] as const)('rejects %s before persistence or state changes', (kind) => {
    const f = fixture();
    try {
      const report = structuredClone(f.report);
      if (!('prerequisiteBlocker' in report.payload) || !report.payload.prerequisiteBlocker)
        throw new Error('fixture');
      if (kind === 'unfrozen') f.getLaunchConfiguration.mockReturnValue(null as never);
      if (kind === 'hash') report.payload.prerequisiteBlocker.requirementsHash = 'f'.repeat(64);
      if (kind === 'membership') report.payload.prerequisiteBlocker.launchers = ['other'];
      if (kind === 'proof') Object.assign(report.payload.prerequisiteBlocker, { resolved: true });
      if (kind === 'root-proof')
        Object.assign(report.payload, { receipt: { outcome: 'qualified' } });
      if (kind === 'phase') Object.assign(report.payload, { phase: undefined });
      if (kind === 'version') Object.assign(report.payload.prerequisiteBlocker, { version: 2 });
      if (!f.launch.work.contract) throw new Error('fixture');
      if (kind === 'builder')
        f.launch.work.contract.executionRequirements = {
          version: 2,
          executables: ['jq'],
          requiresImageBuild: true,
        };
      if (kind === 'native')
        f.launch.work.contract.executionRequirements = {
          version: 2,
          executables: ['jq'],
          platform: 'darwin/arm64',
        };
      expect(() => f.bridge.createEscalation(report)).toThrow();
      expect(f.escalationRepo.listBySession('pod')).toEqual([]);
      expect(f.podRepo.getOrThrow('pod').failureReason).toBeNull();
    } finally {
      f.db.close();
    }
  });
  it('preserves legacy untyped reports, without backfilling qualification', () => {
    const f = fixture();
    try {
      if ('prerequisiteBlocker' in f.report.payload) delete f.report.payload.prerequisiteBlocker;
      f.bridge.createEscalation(f.report);
      expect(f.escalationRepo.getOrThrow('report').payload).not.toHaveProperty(
        'prerequisiteBlocker',
      );
      expect(f.podRepo.hasInfrastructureBlocker('pod')).toBe(true);
    } finally {
      f.db.close();
    }
  });
});
