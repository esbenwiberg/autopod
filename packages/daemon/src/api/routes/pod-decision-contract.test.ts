import { readFileSync } from 'node:fs';
import type { EscalationRequest } from '@autopod/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { PodManager } from '../../pods/pod-manager.js';
import { createPodRepository } from '../../pods/pod-repository.js';
import { createTestDb, insertTestProfile } from '../../test-utils/mock-helpers.js';
import { podRoutes } from './pods.js';

const timestamp = '2026-10-15T12:00:00.000Z';
const question = 'Which implementation should be preserved?';
const decision: EscalationRequest = {
  id: 'decision-contract-question',
  podId: 'decision-contract-pod',
  type: 'ask_human',
  timestamp,
  payload: { question, options: ['First', 'Second'] },
  response: null,
};

describe('decision response contract', () => {
  it('preserves the existing pending decision through detail and both list routes', async () => {
    const db = createTestDb();
    const app = Fastify({ logger: false });
    try {
      insertTestProfile(db);
      const repo = createPodRepository(db);
      repo.insert({
        id: decision.podId,
        profileName: 'test-profile',
        task: 'Preserve the selected implementation',
        status: 'awaiting_input',
        model: 'gpt-5',
        runtime: 'codex',
        executionTarget: 'local',
        branch: 'contract-fixture',
        userId: 'fixture-operator',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      const raw = JSON.stringify(decision);
      db.prepare(
        'UPDATE pods SET pending_escalation = ?, created_at = ?, updated_at = ? WHERE id = ?',
      ).run(raw, timestamp, timestamp, decision.podId);
      db.prepare(`INSERT INTO pod_finalizations
        (pod_id, generation, cycle, phase, agent_settled_at, pending_decision_id, updated_at)
        VALUES (?, 1, 1, 'awaiting_human', ?, ?, ?)`).run(
        decision.podId,
        timestamp,
        decision.id,
        timestamp,
      );
      const manager = {
        getSession: (id: string) => repo.getOrThrow(id),
        listSessions: () => repo.list(),
        getSessionStats: () => ({}),
      } as unknown as PodManager;
      podRoutes(app, manager, undefined, undefined, repo);
      await app.ready();
      const detail = await app.inject({ method: 'GET', url: `/pods/${decision.podId}` });
      const list = await app.inject({ method: 'GET', url: '/pods' });
      const compact = await app.inject({ method: 'GET', url: '/pods?compact=true' });
      for (const response of [detail, list, compact]) expect(response.statusCode).toBe(200);
      const full = detail.json();
      const listed = list.json()[0];
      const summary = compact.json()[0];
      // This committed subset was captured once from these actual route responses.
      // Compare every selected field, including complete nested objects/arrays.
      const contract = JSON.parse(
        readFileSync(
          new URL('../../../../shared/src/fixtures/pod-decision-responses.json', import.meta.url),
          'utf8',
        ),
      );
      for (const [actual, expected] of [
        [full, contract.detail],
        [summary, contract.compact],
      ]) {
        expect(Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]))).toEqual(
          expected,
        );
      }
      expect.soft(full.pendingEscalation).toEqual(decision);
      expect.soft(listed.pendingEscalation).toEqual(decision);
      expect.soft(summary.pendingEscalationSummary).toBe(question);
      for (const pod of [full, listed, summary]) {
        expect.soft(pod.finalization.pendingDecisionId).toBe(decision.id);
        expect
          .soft(pod.recordDiagnostics ?? [])
          .not.toContainEqual({ field: 'pending_escalation', code: 'invalid_shape' });
      }
      const stored = () =>
        db.prepare('SELECT pending_escalation AS raw FROM pods WHERE id = ?').get(decision.podId);
      expect(stored()).toEqual({ raw });
      repo.insert({
        id: 'healthy-neighbor',
        profileName: 'test-profile',
        task: 'Unaffected neighbor',
        status: 'running',
        model: 'gpt-5',
        runtime: 'codex',
        executionTarget: 'local',
        branch: 'neighbor',
        userId: 'fixture-operator',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      const cases = [
        { raw: null, text: null },
        { raw: 'null', text: null },
        { raw: JSON.stringify({ question: 'Legacy' }), text: 'Legacy' },
        {
          raw: JSON.stringify({ ...decision, payload: { question: 'x'.repeat(600) }, extra: true }),
          text: 'x'.repeat(500),
        },
        {
          raw: JSON.stringify({ ...decision, payload: { question: null } }),
          text: null,
          code: 'invalid_shape',
        },
        {
          raw: JSON.stringify({ ...decision, payload: [], question: 'Unsafe fallback' }),
          text: null,
          code: 'invalid_shape',
        },
        { raw: '{broken', text: null, code: 'invalid_json' },
        {
          raw: JSON.stringify({ ...decision, payload: { question: 'x'.repeat(65_536) } }),
          text: null,
          code: 'size_limit',
        },
      ];
      for (const item of cases) {
        db.prepare('UPDATE pods SET pending_escalation = ? WHERE id = ?').run(
          item.raw,
          decision.podId,
        );
        for (const compactMode of [false, true]) {
          const response = await app.inject({ method: 'GET', url: `/pods?compact=${compactMode}` });
          expect(response.statusCode).toBe(200);
          const pods = response.json();
          const changed = pods.find((pod: { id: string }) => pod.id === decision.podId);
          const neighbor = pods.find((pod: { id: string }) => pod.id === 'healthy-neighbor');
          expect(neighbor.status).toBe('running');
          expect(neighbor.recordDiagnostics).toEqual([]);
          const code = item.code === 'size_limit' && !compactMode ? undefined : item.code;
          expect(changed.recordDiagnostics).toEqual(
            code ? [{ field: 'pending_escalation', code }] : [],
          );
          if (compactMode) {
            expect(changed.pendingEscalationSummary).toBe(item.text);
            expect(changed).not.toHaveProperty('pendingEscalation');
          } else {
            expect(changed.pendingEscalation).toEqual(
              code || item.raw === null ? null : JSON.parse(item.raw),
            );
          }
          expect(stored()).toEqual({ raw: item.raw });
        }
      }
    } finally {
      await app.close();
      db.close();
    }
  });
});
