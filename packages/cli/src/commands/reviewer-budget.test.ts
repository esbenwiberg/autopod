import { createServer } from 'node:http';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerReviewerRunsCommand } from './reviewer-runs.js';

it.each([
  200, 404,
])('uses only the explicit reviewer-budget transport and never a task budget/reset endpoint (%s)', async (statusCode) => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      body: body ? JSON.parse(body) : null,
    });
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        statusCode === 404
          ? { error: 'Unsupported control' }
          : req.method === 'GET'
            ? {
                podId: '12345678',
                generation: 3,
                effectiveLimit: 100000,
                recordedTokens: 106959,
                evidenceHash: 'a'.repeat(64),
              }
            : { previousLimit: 100000, limit: 150000, recordedTokens: 106959 },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('Missing port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    getToken: async () => 'synthetic',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (...args: string[]) => {
    const p = new Command().exitOverride();
    registerReviewerRunsCommand(p, () => client);
    await p.parseAsync(['reviewer-budget', '12345678', ...args], { from: 'user' });
  };
  try {
    await expect(run('--limit', '150000')).rejects.toThrow('explicit --apply');
    await expect(run('--apply', '--limit', '150000')).rejects.toThrow();
    const args = [
      '--apply',
      '--request-id',
      'approved-cap',
      '--generation',
      '3',
      '--expected-limit',
      '100000',
      '--evidence-hash',
      'a'.repeat(64),
      '--limit',
      '150000',
      '--reason',
      'Owner approved a finite reviewer increase',
      '--ack-usage-retained',
      '--json',
    ];
    await expect(run(...args.filter((x) => x !== '--ack-usage-retained'))).rejects.toThrow();
    expect(requests).toHaveLength(0);
    if (statusCode === 200) {
      await run('--json');
      await run(...args);
    } else {
      await expect(run('--json')).rejects.toThrow();
      await expect(run(...args)).rejects.toThrow();
    }
    expect(requests).toEqual([
      { method: 'GET', url: '/pods/12345678/reviewer-budget', body: null },
      {
        method: 'POST',
        url: '/pods/12345678/reviewer-budget',
        body: {
          requestId: 'approved-cap',
          expectedGeneration: 3,
          expectedLimit: 100000,
          expectedEvidenceHash: 'a'.repeat(64),
          limit: 150000,
          reason: 'Owner approved a finite reviewer increase',
          acknowledgement: 'increase-only-usage-retained',
        },
      },
    ]);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
