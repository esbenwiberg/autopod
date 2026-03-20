import { describe, expect, it, vi } from 'vitest';
import { actionParamsToZodShape, executeAction } from './actions.js';

interface ActionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  sanitized: boolean;
  quarantined: boolean;
}

function makeBridge(response: ActionResponse) {
  return {
    executeAction: vi.fn().mockResolvedValue(response),
  };
}

describe('executeAction', () => {
  it('returns formatted JSON on success', async () => {
    const bridge = makeBridge({
      success: true,
      data: { status: 'ok', count: 3 },
      sanitized: false,
      quarantined: false,
    });

    const result = await executeAction('sess-1', 'deploy', { env: 'prod' }, bridge as never);

    expect(result).toBe(JSON.stringify({ status: 'ok', count: 3 }, null, 2));
  });

  it('returns error message on failure', async () => {
    const bridge = makeBridge({
      success: false,
      error: 'timeout exceeded',
      sanitized: false,
      quarantined: false,
    });

    const result = await executeAction('sess-1', 'deploy', {}, bridge as never);

    expect(result).toBe('Action failed: timeout exceeded');
  });

  it('prepends quarantine notice when response.quarantined is true', async () => {
    const bridge = makeBridge({
      success: true,
      data: { value: 'filtered' },
      sanitized: false,
      quarantined: true,
    });

    const result = await executeAction('sess-1', 'deploy', {}, bridge as never);

    expect(result).toContain('quarantined');
    expect(result).toContain('injection detection');
    expect(result).toContain(JSON.stringify({ value: 'filtered' }, null, 2));
  });

  it('passes correct args to bridge.executeAction', async () => {
    const bridge = makeBridge({
      success: true,
      data: null,
      sanitized: false,
      quarantined: false,
    });

    await executeAction('sess-99', 'restart', { force: true }, bridge as never);

    expect(bridge.executeAction).toHaveBeenCalledOnce();
    expect(bridge.executeAction).toHaveBeenCalledWith('sess-99', 'restart', { force: true });
  });

  it('handles null data gracefully', async () => {
    const bridge = makeBridge({
      success: true,
      data: null,
      sanitized: false,
      quarantined: false,
    });

    const result = await executeAction('sess-1', 'noop', {}, bridge as never);

    expect(result).toBe('null');
  });
});

describe('actionParamsToZodShape', () => {
  it('converts required string param correctly', () => {
    const action = {
      name: 'deploy',
      description: 'Deploy',
      params: {
        env: { type: 'string', description: 'Target environment', required: true },
      },
    };

    const shape = actionParamsToZodShape(action as never);

    expect(shape.env).toEqual({
      type: 'string',
      description: 'Target environment',
      optional: false,
    });
  });

  it('converts optional number param', () => {
    const action = {
      name: 'scale',
      description: 'Scale',
      params: {
        replicas: { type: 'number', description: 'Replica count', required: false },
      },
    };

    const shape = actionParamsToZodShape(action as never);

    expect(shape.replicas).toEqual({
      type: 'number',
      description: 'Replica count',
      optional: true,
    });
  });

  it('handles multiple params of different types', () => {
    const action = {
      name: 'configure',
      description: 'Configure',
      params: {
        name: { type: 'string', description: 'Name', required: true },
        count: { type: 'number', description: 'Count', required: false },
        force: { type: 'boolean', description: 'Force flag', required: true },
      },
    };

    const shape = actionParamsToZodShape(action as never);

    expect(Object.keys(shape)).toHaveLength(3);
    expect(shape.name.optional).toBe(false);
    expect(shape.count.optional).toBe(true);
    expect(shape.force.type).toBe('boolean');
  });

  it('handles empty params object', () => {
    const action = {
      name: 'noop',
      description: 'No-op',
      params: {},
    };

    const shape = actionParamsToZodShape(action as never);

    expect(shape).toEqual({});
  });

  it('preserves descriptions', () => {
    const action = {
      name: 'test',
      description: 'Test',
      params: {
        verbose: {
          type: 'boolean',
          description: 'Enable verbose logging with detailed stack traces',
          required: false,
        },
      },
    };

    const shape = actionParamsToZodShape(action as never);

    expect(shape.verbose.description).toBe('Enable verbose logging with detailed stack traces');
  });
});
