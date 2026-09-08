import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerManagedCommands } from './managed.js';
const state = vi.hoisted(() => ({ token: '', endpoint: 'https://daemon.test' }));
vi.mock('../config/credential-store.js', () => ({
  readCredentials: () => ({ accessToken: state.token }),
}));
vi.mock('../config/config-store.js', () => ({ get: () => state.endpoint }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});
async function run(input: string) {
  const out: string[] = [];
  const errors: string[] = [];
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from(input);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    out.push(String(text));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    errors.push(String(text));
    return true;
  });
  const program = new Command();
  registerManagedCommands(program);
  await program.parseAsync(
    [
      'managed-request',
      '--endpoint',
      state.endpoint,
      '--issuer',
      'https://issuer/',
      '--audience',
      'api://autopod',
      '--object-id',
      'owner',
    ],
    { from: 'user' },
  );
  return { out, errors };
}
it('CLI reads its existing login and returns only the protocol response', async () => {
  state.token = `fixture.${Buffer.from(JSON.stringify({ iss: 'https://issuer/', aud: 'api://autopod', oid: 'owner', exp: Date.now() / 1000 + 60 })).toString('base64url')}.signature`;
  const fetcher = vi.fn(async () => new Response('{"enabled":false}'));
  vi.stubGlobal('fetch', fetcher);
  const result = await run('{"method":"GET","path":"/managed/health"}');
  expect(result.out.join('')).toBe('{"body":{"enabled":false}}\n');
  expect(result.errors).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(state.token);
});
it('CLI redacts malformed input and unusable login, with no network or credential output', async () => {
  state.token = 'reusable-secret';
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await run('{"method":"GET","path":"/managed/health"}');
  expect(result.out).toEqual([]);
  expect(result.errors.join('')).toContain('managed-request-unavailable');
  expect(result.errors.join('')).not.toContain(state.token);
  expect(fetcher).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
