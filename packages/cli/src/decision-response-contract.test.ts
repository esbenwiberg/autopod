import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, createCliFixture } from './test-utils/cli-executable.js';

const contract = JSON.parse(
  readFileSync(
    new URL('../../shared/src/fixtures/pod-decision-responses.json', import.meta.url),
    'utf8',
  ),
);

describe('built CLI decision response contract', () => {
  it.each(['detail', 'compact'] as const)(
    'preserves the daemon-derived %s response in JSON',
    async (mode) => {
      const fixture = await createCliFixture({
        respond: (response, requestNumber) => {
          response.setHeader('content-type', 'application/json');
          if (mode === 'detail' && requestNumber === 2) {
            response.writeHead(404);
            response.end(
              JSON.stringify({ code: 'NOT_FOUND', message: 'No task execution fixture' }),
            );
          } else {
            response.end(JSON.stringify(mode === 'detail' ? contract.detail : [contract.compact]));
          }
        },
      });
      try {
        const args =
          mode === 'detail'
            ? ['status', contract.detail.id, '--json']
            : ['ls', '--compact', '--json', '--limit', '1'];
        const child = fixture.start(args);
        const result = await child.result;
        expect(result.failure).toBeNull();
        expect(result.cancelled).toBe(false);
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderr).not.toContain('Error:');
        expect(JSON.parse(result.stdout)).toEqual(
          mode === 'detail' ? { ...contract.detail, taskExecution: null } : [contract.compact],
        );
        const urls =
          mode === 'detail'
            ? [`/pods/${contract.detail.id}`, `/pods/${contract.detail.id}/task-execution`]
            : ['/pods?limit=1&compact=true'];
        expect(fixture.requests).toEqual(
          urls.map((url) => ({ method: 'GET', url, authorization: `Bearer ${FIXTURE_TOKEN}` })),
        );
        expect(child.closed).toBe(true);
        expect(child.timerActive).toBe(false);
      } finally {
        await fixture.dispose();
        expect(fixture.childrenClosed).toBe(true);
        expect(fixture.listening).toBe(false);
        expect(fixture.socketCount).toBe(0);
        expect(fixture.websocketCount).toBe(0);
        await expect(access(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
    30_000,
  );
});
