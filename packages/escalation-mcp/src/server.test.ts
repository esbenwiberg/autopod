import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PodBridge } from './pod-bridge.js';

type ToolHandler = (input: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolRegistration = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: ToolHandler;
};

const { toolRegistrations } = vi.hoisted(() => ({
  toolRegistrations: [] as ToolRegistration[],
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires regular functions for class mocks
  McpServer: vi.fn().mockImplementation(function () {
    return {
      tool: vi.fn(
        (name: string, description: string, schema: z.ZodRawShape, handler: ToolHandler) => {
          toolRegistrations.push({ name, description, schema, handler });
        },
      ),
    };
  }),
}));

function makeBridge(overrides: Partial<PodBridge> = {}): PodBridge {
  return {
    createEscalation: vi.fn(),
    resolveEscalation: vi.fn(),
    getAiEscalationCount: vi.fn().mockReturnValue(0),
    getMaxAiCalls: vi.fn().mockReturnValue(5),
    getAutoPauseThreshold: vi.fn().mockReturnValue(3),
    getHumanResponseTimeout: vi.fn().mockReturnValue(5),
    getHumanResponseOnTimeout: vi.fn().mockReturnValue('continue'),
    logEscalationAnswer: vi.fn(),
    getReviewerModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    callReviewerModel: vi.fn().mockResolvedValue('The AI says: proceed'),
    incrementEscalationCount: vi.fn(),
    isAskHumanDisabled: vi.fn().mockReturnValue(false),
    reportPlan: vi.fn(),
    reportProgress: vi.fn(),
    reportTaskSummary: vi.fn(),
    consumeMessages: vi.fn().mockReturnValue({ hasMessage: false }),
    actionRequiresApproval: vi.fn().mockReturnValue(false),
    executeAction: vi.fn(),
    getAvailableActions: vi.fn().mockReturnValue([]),
    writeFileInContainer: vi.fn(),
    execInContainer: vi.fn(),
    getPreviewUrl: vi.fn().mockReturnValue(null),
    runBrowserOnHost: vi.fn().mockResolvedValue(null),
    readHostScreenshot: vi.fn().mockResolvedValue(null),
    storeScreenshot: vi.fn(),
    getHostScreenshotDir: vi.fn().mockReturnValue(null),
    getLinkedPodId: vi.fn().mockReturnValue(null),
    readMemory: vi.fn(),
    listMemories: vi.fn().mockReturnValue([]),
    searchMemories: vi.fn().mockReturnValue([]),
    suggestMemory: vi.fn(),
    revalidateLinkedPod: vi.fn(),
    validateBrowserUrl: vi.fn(),
    runValidationPhase: vi.fn(),
    runPreSubmitReview: vi.fn(),
    ...overrides,
  };
}

function getTool(name: string): ToolRegistration {
  const tool = toolRegistrations.find((registration) => registration.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

describe('createEscalationMcpServer memory reporting schema', () => {
  beforeEach(() => {
    toolRegistrations.length = 0;
  });

  it('registers report_plan memory intent schema and passes accepted values to the bridge', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge();
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const reportPlan = getTool('report_plan');
    const schema = z.object(reportPlan.schema);
    const input = schema.parse({
      summary: 'Refactor auth module',
      steps: ['Extract interface'],
      memoryIntents: [{ memoryId: 'mem-1', reason: 'Use its repository convention.' }],
    });

    const result = await reportPlan.handler(input);

    expect(bridge.reportPlan).toHaveBeenCalledWith(
      'sess-1',
      'Refactor auth module',
      ['Extract interface'],
      [{ memoryId: 'mem-1', reason: 'Use its repository convention.' }],
    );
    expect(result.content[0]?.text).toContain('1 memory intent recorded');
  });

  it('rejects invalid report_plan memory intent items before bridge invocation', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge();
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const schema = z.object(getTool('report_plan').schema);

    expect(() =>
      schema.parse({
        summary: 'Refactor auth module',
        steps: ['Extract interface'],
        memoryIntents: [{ memoryId: 'mem-1' }],
      }),
    ).toThrow();
  });

  it('registers report_task_summary memory outcome schema and passes accepted values to the bridge', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge();
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const reportTaskSummary = getTool('report_task_summary');
    const schema = z.object(reportTaskSummary.schema);
    const input = schema.parse({
      actualSummary: 'Done',
      deviations: [],
      memoryOutcomes: [
        { memoryId: 'mem-1', outcome: 'applied', reason: 'Used the repository convention.' },
        { memoryId: 'mem-2', outcome: 'not_applicable', reason: 'No matching files changed.' },
        { memoryId: 'mem-3', outcome: 'harmful_stale', reason: 'Contradicted current code.' },
      ],
    });

    const result = await reportTaskSummary.handler(input);

    expect(bridge.reportTaskSummary).toHaveBeenCalledWith(
      'sess-1',
      'Done',
      [],
      undefined,
      undefined,
      undefined,
      [
        { memoryId: 'mem-1', outcome: 'applied', reason: 'Used the repository convention.' },
        { memoryId: 'mem-2', outcome: 'not_applicable', reason: 'No matching files changed.' },
        { memoryId: 'mem-3', outcome: 'harmful_stale', reason: 'Contradicted current code.' },
      ],
      undefined,
    );
    expect(result.content[0]?.text).toContain('3 memory outcomes recorded');
  });

  it('registers report_task_summary review feedback response schema', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge();
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const reportTaskSummary = getTool('report_task_summary');
    const schema = z.object(reportTaskSummary.schema);
    const input = schema.parse({
      actualSummary: 'Fixed requested feedback',
      deviations: [],
      reviewFeedbackResponses: [
        {
          feedbackId: 'gh-comment-123',
          outcome: 'fixed',
          response: 'Renamed the option and added coverage.',
        },
        {
          feedbackId: 'ado-thread-456',
          outcome: 'needs_reviewer_decision',
          response: 'This request conflicts with the existing public API.',
        },
      ],
    });

    const result = await reportTaskSummary.handler(input);

    expect(bridge.reportTaskSummary).toHaveBeenCalledWith(
      'sess-1',
      'Fixed requested feedback',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          feedbackId: 'gh-comment-123',
          outcome: 'fixed',
          response: 'Renamed the option and added coverage.',
        },
        {
          feedbackId: 'ado-thread-456',
          outcome: 'needs_reviewer_decision',
          response: 'This request conflicts with the existing public API.',
        },
      ],
    );
    expect(result.content[0]?.text).toContain('2 review feedback responses recorded');
  });

  it('rejects invalid report_task_summary memory outcome values before bridge invocation', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge();
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const schema = z.object(getTool('report_task_summary').schema);

    expect(() =>
      schema.parse({
        actualSummary: 'Done',
        deviations: [],
        memoryOutcomes: [{ memoryId: 'mem-1', outcome: 'stale', reason: 'Invalid.' }],
      }),
    ).toThrow();
  });

  it('propagates daemon-side missing memory reporting rejections so the agent can retry', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge({
      reportTaskSummary: vi.fn(() => {
        throw new Error('memoryOutcomes is required because selected/injected memories exist.');
      }),
    });
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const reportTaskSummary = getTool('report_task_summary');
    const input = z.object(reportTaskSummary.schema).parse({
      actualSummary: 'Done',
      deviations: [],
    });

    await expect(reportTaskSummary.handler(input)).rejects.toThrow(/memoryOutcomes is required/);
  });

  it('accepts setup in validate_locally phases schema and forwards it to validation', async () => {
    const { createEscalationMcpServer } = await import('./server.js');
    const bridge = makeBridge({
      runValidationPhase: vi.fn(async (_podId, phase) => ({
        phase,
        configured: true,
        passed: true,
        exitCode: 0,
        command: `${phase}-command`,
        durationMs: 1,
        output: '',
      })),
    });
    createEscalationMcpServer({ podId: 'sess-1', bridge });
    const validateLocally = getTool('validate_locally');
    const schema = z.object(validateLocally.schema);
    const input = schema.parse({ phases: ['setup', 'lint'] });

    const result = await validateLocally.handler(input);

    expect(bridge.runValidationPhase).toHaveBeenCalledWith('sess-1', 'setup');
    expect(bridge.runValidationPhase).toHaveBeenCalledWith('sess-1', 'lint');
    expect(result.content[0]?.text).toContain('"passed": true');
  });
});
