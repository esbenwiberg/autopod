import type { DiffResponse, Pod } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { FIXTURE_TOKEN, createCliFixture } from '../test-utils/cli-executable.js';
import { registerValidateCommands } from './validate.js';

const patch =
  'diff --git a/src/check.test.ts b/src/check.test.ts\n' +
  'new file mode 100644\n--- /dev/null\n+++ b/src/check.test.ts\n' +
  '@@ -0,0 +1 @@\n+test();\n';
const removedPatch =
  'diff --git a/old.ts b/old.ts\n' +
  'deleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n' +
  '@@ -1 +0,0 @@\n-old();\n';
const response: DiffResponse = {
  files: [
    { path: 'src/check.test.ts', status: 'added', diff: patch },
    { path: 'old.ts', status: 'deleted', diff: removedPatch },
  ],
  stats: { added: 1, removed: 1, changed: 2 },
  previewFiles: [{ path: 'untracked.txt', status: 'added', diff: 'preview only', truncated: true }],
  previewStats: { added: 1, removed: 0, changed: 1 },
  uncommittedFiles: [],
  uncommittedStats: { added: 0, removed: 0, changed: 0 },
  commits: [],
  commitGroupingUnavailableReason: 'No container available',
};

function storedReview(diff: string | null): Pod {
  return {
    id: '12345678',
    status: 'validated',
    prUrl: 'https://github.com/org/repo/pull/1',
    lastValidationResult: {
      taskReview: diff === null ? null : { diff },
      reviewSkipKind: diff === null ? 'profile-skip' : undefined,
    },
  } as Pod;
}

describe('ap diff', () => {
  let client: AutopodClient;
  let program: Command;

  beforeEach(() => {
    client = new AutopodClient({ baseUrl: 'http://localhost:3100', getToken: async () => 'token' });
    vi.spyOn(client, 'getPodDiff').mockResolvedValue(response);
    vi.spyOn(client, 'getSession').mockResolvedValue(storedReview(null));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    program = new Command().exitOverride();
    registerValidateCommands(program, () => client);
  });

  afterEach(() => vi.restoreAllMocks());

  const args = (json: boolean) => ['diff', '12345678', ...(json ? ['--json'] : [])];

  it('prints canonical patches when task review was skipped, without printing preview files', async () => {
    await program.parseAsync(args(false), { from: 'user' });
    expect(client.getPodDiff).toHaveBeenCalledExactlyOnceWith('12345678');
    expect(client.getSession).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(patch + removedPatch);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('prints the entire endpoint response as JSON without terminal decoration', async () => {
    await program.parseAsync(args(true), { from: 'user' });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(response, null, 2));
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('resolves abbreviated IDs before fetching the diff', async () => {
    vi.spyOn(client, 'listSessions').mockResolvedValue([storedReview(null)]);
    await program.parseAsync(['diff', '123', '--json'], { from: 'user' });
    expect(client.getPodDiff).toHaveBeenCalledExactlyOnceWith('12345678');
  });

  it.each([false, true])(
    'does not replace a successful empty diff with stale review data (json=%s)',
    async (json) => {
      const empty = { ...response, files: [], stats: { added: 0, removed: 0, changed: 0 } };
      vi.mocked(client.getPodDiff).mockResolvedValue(empty);
      vi.mocked(client.getSession).mockResolvedValue(storedReview(patch));
      await program.parseAsync(args(json), { from: 'user' });
      expect(client.getSession).not.toHaveBeenCalled();
      expect(process.stdout.write).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledExactlyOnceWith(
        json
          ? JSON.stringify(empty, null, 2)
          : expect.stringContaining('No changes in the pod diff.'),
      );
    },
  );

  it.each([false, true])(
    'falls back to the stored review only on endpoint failure (json=%s)',
    async (json) => {
      vi.mocked(client.getPodDiff).mockRejectedValue(new Error('Route unavailable'));
      vi.mocked(client.getSession).mockResolvedValue(storedReview(patch + removedPatch));
      await program.parseAsync(args(json), { from: 'user' });
      expect(client.getSession).toHaveBeenCalledExactlyOnceWith('12345678');
      if (json) {
        expect(console.log).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify(
            { files: response.files, stats: response.stats, source: 'task-review' },
            null,
            2,
          ),
        );
        expect(process.stdout.write).not.toHaveBeenCalled();
      } else {
        expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(patch + removedPatch);
        expect(console.log).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    'preserves failure when neither source has a diff (json=%s)',
    async (json) => {
      const error = new Error('Diff unavailable');
      vi.mocked(client.getPodDiff).mockRejectedValue(error);
      await expect(program.parseAsync(args(json), { from: 'user' })).rejects.toBe(error);
      expect(console.log).not.toHaveBeenCalled();
      expect(process.stdout.write).not.toHaveBeenCalled();
    },
  );

  it('propagates failure to fetch the fallback pod', async () => {
    vi.mocked(client.getPodDiff).mockRejectedValue(new Error('Diff unavailable'));
    vi.mocked(client.getSession).mockRejectedValue(new Error('Pod not found'));
    await expect(program.parseAsync(args(true), { from: 'user' })).rejects.toThrow('Pod not found');
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('built ap diff', () => {
  it.each([false, true])(
    'emits parseable JSON through authenticated HTTP (fallback=%s)',
    async (fallback) => {
      const fixture = await createCliFixture({
        respond: (reply, requestNumber) => {
          reply.setHeader('content-type', 'application/json');
          if (fallback && requestNumber === 1) {
            reply.statusCode = 404;
            reply.end(JSON.stringify({ message: 'Route unavailable' }));
          } else {
            reply.end(JSON.stringify(fallback ? storedReview(patch + removedPatch) : response));
          }
        },
      });
      try {
        const result = await fixture.start(['diff', '12345678', '--json']).result;
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(
          fallback
            ? { files: response.files, stats: response.stats, source: 'task-review' }
            : response,
        );
        expect(fixture.requests).toEqual(
          ['/pods/12345678/diff', ...(fallback ? ['/pods/12345678'] : [])].map((url) => ({
            method: 'GET',
            url,
            authorization: `Bearer ${FIXTURE_TOKEN}`,
          })),
        );
      } finally {
        await fixture.dispose();
      }
    },
  );
});
