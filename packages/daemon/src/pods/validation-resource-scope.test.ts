import { describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  captureDockerValidationResourceScope,
  isDockerValidationResourceKey,
} from './validation-resource-scope.js';

const id = 'a'.repeat(64);
const key = JSON.stringify(['docker', 'engine-identity', id]);

describe('maintained Docker validation identity', () => {
  it('requires a canonical exact engine and full container identity', () => {
    expect(isDockerValidationResourceKey(key, id)).toBe(true);
    for (const value of [
      undefined,
      '',
      'not JSON',
      'docker:local',
      JSON.stringify(['docker', id]),
      JSON.stringify(['sandbox', 'engine-identity', id]),
      JSON.stringify(['docker', '', id]),
      JSON.stringify(['docker', 'engine\nidentity', id]),
      JSON.stringify(['docker', 'engine-identity', 'b'.repeat(64)]),
      JSON.stringify(['docker', 'engine-identity', id, 'extra']),
      JSON.stringify(['docker', 'engine-identity', id], null, 2),
    ])
      expect(isDockerValidationResourceKey(value, id)).toBe(false);
    expect(isDockerValidationResourceKey(key, id.slice(0, 12))).toBe(false);
  });

  it('observes the backend key instead of accepting an endpoint or cached sandbox scope', async () => {
    const manager = createMockContainerManager();
    Object.assign(manager, { executionResourceScope: 'not-docker-proof' });
    await expect(captureDockerValidationResourceScope(manager, id)).rejects.toMatchObject({
      code: 'VALIDATION_RESOURCE_IDENTITY_UNAVAILABLE',
    });
    manager.getResourceKey = vi.fn(async () => key);
    expect(await captureDockerValidationResourceScope(manager, id)).toBe(key);
    expect(manager.getResourceKey).toHaveBeenCalledExactlyOnceWith(id);
    vi.mocked(manager.getResourceKey).mockResolvedValue('not-docker-proof');
    await expect(captureDockerValidationResourceScope(manager, id)).rejects.toMatchObject({
      code: 'VALIDATION_RESOURCE_IDENTITY_UNAVAILABLE',
    });
    vi.mocked(manager.getResourceKey).mockRejectedValue(new Error('Docker observation failed'));
    await expect(captureDockerValidationResourceScope(manager, id)).rejects.toThrow(
      'observation failed',
    );
    expect(manager.execInContainer).not.toHaveBeenCalled();
  });
});
