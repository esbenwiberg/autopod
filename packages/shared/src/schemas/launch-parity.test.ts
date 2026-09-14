import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchRequestSchema, savedLaunchSelectionSchema } from './launch-config.schema.js';

describe('desktop and CLI shared launch fixture', () => {
  it('preserves saved schedule selections but rejects task, retry and daemon origin fields', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/composable-launch.json', import.meta.url), 'utf8'),
    );
    const {
      task: _,
      work: _work,
      requestId: _request,
      expectedDigest: _digest,
      ...selection
    } = fixture;
    expect(savedLaunchSelectionSchema.parse(selection)).toEqual(selection);
    for (const key of ['task', 'work', 'requestId', 'expectedDigest', 'origin'])
      expect(savedLaunchSelectionSchema.safeParse({ ...selection, [key]: 'forged' }).success).toBe(
        false,
      );
  });
  it('is a complete canonical shared request with explicit clears and separate workflow/branch scopes', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('../fixtures/composable-launch.json', import.meta.url), 'utf8'),
    );
    const request = launchRequestSchema.parse(fixture);
    expect(request).toEqual(fixture);
    expect(request.selections?.githubAccessId).toBeNull();
    expect(request.overrides?.githubAccess?.rules?.[0]?.workflows).toEqual({ mode: 'all' });
    expect(request.overrides?.githubAccess?.rules?.[0]?.branches).toEqual({
      mode: 'selected',
      names: ['main'],
    });
  });
});
