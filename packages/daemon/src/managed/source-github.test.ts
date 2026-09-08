import { readFileSync } from 'node:fs';
import type { FinalizeSourceDeliveryRequest } from '@autopod/shared';
import { expect, it } from 'vitest';
import { sha256 } from './canonical.js';
import { GitHubDraftBroker } from './source-github.js';

it('keeps credentials daemon-side, verifies body digest, creates only a draft, and refuses a closed PR replacement', async () => {
  const spec = JSON.parse(
    readFileSync(
      new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
      'utf8',
    ),
  ).FinalizeSourceDeliveryRequest as FinalizeSourceDeliveryRequest;
  spec.operation = 'draft-pr';
  spec.repository = 'repo';
  spec.head = 'worker/one';
  spec.base = 'main';
  spec.newCommit = '1'.repeat(40);
  spec.bodyDigest = sha256(Buffer.from('Reviewed body'));
  const calls: { url: string; method: string; body: unknown }[] = [];
  let closed = false;
  const record = () => ({
    number: 5,
    draft: true,
    state: closed ? 'closed' : 'open',
    merged: false,
    body: 'Reviewed body',
    head: { ref: spec.head, sha: spec.newCommit, repo: { full_name: 'owned/repo' } },
    base: { ref: 'main', repo: { full_name: 'owned/repo' } },
  });
  const transport: typeof fetch = async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-ephemeral');
    expect(init?.redirect).toBe('error');
    const url = String(input);
    calls.push({
      url,
      method: init?.method!,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(url.includes('?') ? [record()] : record()), {
      status: 200,
      headers: { etag: '"fixture"' },
    });
  };
  const broker = new GitHubDraftBroker(
    new Map([['repo', 'owned/repo']]),
    async () => 'fixture-ephemeral',
    async () => 'Reviewed body',
    transport,
  );
  expect(await broker.create(spec)).toMatchObject({ draft: true, id: 5 });
  expect(calls[0]?.body).toMatchObject({
    draft: true,
    head: 'worker/one',
    base: 'main',
    body: 'Reviewed body',
  });
  expect(Object.keys(calls[0]?.body as object)).not.toContain('token');
  await expect(broker.create({ ...spec, bodyDigest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(
    'digest-mismatch',
  );
  closed = true;
  await expect(broker.inspect(spec)).rejects.toThrow('response-invalid');
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});
