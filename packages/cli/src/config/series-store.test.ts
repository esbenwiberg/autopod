import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SeriesLaunchRequest, seriesLaunchRequestSchema } from '@autopod/shared';
import { expect, it } from 'vitest';
import { saveSeriesReceipt } from './launch-store.js';

it('saves the exact series request privately and refuses a different payload for the same key', () => {
  const folder = mkdtempSync(join(tmpdir(), 'series-receipt-'));
  try {
    const request: SeriesLaunchRequest = {
      requestId: 'retry',
      seriesName: 'Feature',
      launch: { repositoryId: 'repo', selections: { githubAccessId: null, toolPackIds: [] } },
      briefs: [{ title: 'First', task: 'Implement', dependsOn: [] }],
    };
    const path = saveSeriesReceipt(request, folder);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
      seriesLaunchRequestSchema.parse(request),
    );
    expect(saveSeriesReceipt(request, folder)).toBe(path);
    expect(() => saveSeriesReceipt({ ...request, seriesName: 'Changed' }, folder)).toThrow(
      'different request',
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
