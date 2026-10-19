import { expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { ReviewerRunRepository } from './reviewer-run-repository.js';

it.each(['unlimited', 'soft', 'hard', 'removed'] as const)(
  'admits in-flight review according to an explicit %s budget',
  async (mode) => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Review a canary',
          overrides: {
            workflow: {
              tokenBudget: mode === 'unlimited' ? null : 100000,
              tokenBudgetPolicy: mode === 'soft' ? 'soft' : 'hard',
            },
          },
        },
        services,
      );
      insertConfigurationTestPod(db, 'acceptance');
      db.prepare(
        "UPDATE pods SET launch_config_digest=?, token_budget=?, token_telemetry_accuracy='complete' WHERE id='acceptance'",
      ).run(config.digest, config.workflow.tokenBudget);
      db.exec(
        "INSERT INTO pod_goals(pod_id,objective,state,runtime,execution_stopped,native_session_id,last_sequence,observed_tokens,created_at,updated_at) VALUES('acceptance','Review a canary','active','codex',0,'session',3,100,'now','now')",
      );
      const repo = createPodRepository(db);
      const ledger = repo.taskExecutions;
      if (!ledger) throw new Error('Missing task ledger');
      ledger.register('acceptance');
      if (mode === 'removed') ledger.raiseBudget('acceptance', null, 100000, 'operator');
      const runs = new ReviewerRunRepository(db, (id) => ledger.snapshot(id));
      const pod = repo.getOrThrow('acceptance');
      expect(ledger.snapshot('acceptance').recordedTotalTokens).toBe(100);
      if (mode === 'hard') {
        expect(() => runs.reserve('in-flight', pod, config, config.ai.main)).toThrow(
          'Reconcile task usage',
        );
      } else {
        runs.reserve('in-flight', pod, config, config.ai.main);
        expect(db.prepare('SELECT state FROM isolated_reviewer_runs').get()).toEqual({
          state: 'preparing',
        });
        // Removing a budget never releases ownership of another running/uncertain reviewer.
        expect(() => runs.reserve('duplicate', pod, config, config.ai.main)).toThrow(
          'previous reviewer',
        );
      }
    } finally {
      db.close();
    }
  },
);
