import Anthropic from '@anthropic-ai/sdk';
import { vi } from 'vitest';
import { createAdmissionFixture } from './admission-queries-helpers.js';

export function createMemoryBriefingSdkFixture() {
  const f = createAdmissionFixture();
  const memory = f.memoryRepo.insert({
    id: 'briefing-memory',
    scope: 'profile',
    scopeId: 'test-profile',
    path: '/auth-token.md',
    content: 'Authentication token refresh workflow',
    rationale: null,
    kind: 'workflow',
    tags: ['auth'],
    appliesWhen: null,
    avoidWhen: null,
    confidence: 0.9,
    sourceEvidence: [],
    impactSummary: null,
    approved: true,
    createdByPodId: null,
  });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'fixture-message',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                selected: [
                  { id: memory.id, reason: 'Fixture reviewer selected authentication guidance' },
                ],
              }),
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const client = new Anthropic({ apiKey: 'fixture-key-not-real', fetch, maxRetries: 0 });
  return { f, memory, fetch, client };
}
