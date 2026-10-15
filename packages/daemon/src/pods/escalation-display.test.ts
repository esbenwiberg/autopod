import type { EscalationRequest } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { escalationDisplaySummary, isDisplayEscalation } from './escalation-display.js';

const envelope = {
  id: 'decision',
  podId: 'pod',
  timestamp: '2026-10-15T12:00:00.000Z',
  response: null,
};
const variants: { request: EscalationRequest; summary: string | null }[] = [
  {
    request: {
      ...envelope,
      type: 'ask_human',
      payload: { question: 'Choose', options: ['A', 'B'] },
    },
    summary: 'Choose',
  },
  {
    request: { ...envelope, type: 'ask_ai', payload: { question: 'Explain', domain: 'test' } },
    summary: 'Explain',
  },
  {
    request: {
      ...envelope,
      type: 'report_blocker',
      payload: { description: 'Blocked', attempted: [], needs: 'Help' },
    },
    summary: 'Blocked',
  },
  {
    request: {
      ...envelope,
      type: 'action_approval',
      payload: { actionName: 'test', params: {}, description: 'Approve' },
    },
    summary: 'Approve',
  },
  {
    request: {
      ...envelope,
      type: 'validation_override',
      payload: { findings: [], attempt: 1, maxAttempts: 3 },
    },
    summary: null,
  },
  {
    request: {
      ...envelope,
      type: 'request_credential',
      payload: { service: 'github', reason: 'Read repository' },
    },
    summary: 'Read repository',
  },
];

describe('escalation display qualification', () => {
  it.each(variants)('preserves $request.type without inventing text', ({ request, summary }) => {
    const before = JSON.stringify(request);
    expect(isDisplayEscalation(request)).toBe(true);
    expect(escalationDisplaySummary(request)).toBe(summary);
    expect(JSON.stringify(request)).toBe(before);
  });
  it('allows absent response and unknown fields and chooses existing text in priority order', () => {
    const request = {
      ...envelope,
      type: 'future',
      response: undefined,
      extra: true,
      payload: { question: '', description: 'Second', reason: 'Third', extra: [1] },
    };
    expect(isDisplayEscalation(request)).toBe(true);
    expect(escalationDisplaySummary(request)).toBe('');
    expect(
      escalationDisplaySummary({ ...request, payload: { description: 'Second', reason: 'Third' } }),
    ).toBe('Second');
  });
  it.each([null, undefined])('treats %s as no decision', (value) => {
    expect(isDisplayEscalation(value)).toBe(true);
    expect(escalationDisplaySummary(value)).toBeNull();
  });
  it('retains legacy flattened question compatibility', () => {
    expect(isDisplayEscalation({ question: 'Legacy' })).toBe(true);
    expect(escalationDisplaySummary({ question: 'Legacy' })).toBe('Legacy');
  });
  it.each([
    [],
    1,
    'text',
    {},
    { question: null },
    { ...envelope, type: 'ask_human', payload: null, question: 'Do not fall back' },
    { ...envelope, type: 'ask_human', payload: [], question: 'Do not fall back' },
    { ...envelope, type: 'ask_human', payload: { question: 1 } },
    { ...envelope, type: 'ask_human', payload: { question: 'Valid', description: null } },
    { ...envelope, type: 'request_credential', payload: { reason: [] } },
    { ...envelope, id: null, type: 'ask_human', payload: { question: 'Valid' } },
  ])('rejects malformed display input %#', (value) => {
    expect(isDisplayEscalation(value)).toBe(false);
    expect(escalationDisplaySummary(value)).toBeNull();
  });
});
