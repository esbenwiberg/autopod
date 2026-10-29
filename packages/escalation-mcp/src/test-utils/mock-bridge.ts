import { vi } from 'vitest';
import type { PodBridge } from '../pod-bridge.js';

export function createMockBridge(overrides: Partial<PodBridge> = {}): PodBridge {
  return {
    createEscalation: vi.fn(),
    resolveEscalation: vi.fn(),
    getAiEscalationCount: vi.fn().mockReturnValue(0),
    getAutoPauseCount: vi.fn().mockReturnValue(0),
    getMaxAiCalls: vi.fn().mockReturnValue(5),
    getAutoPauseThreshold: vi.fn().mockReturnValue(3),
    getHumanResponseTimeout: vi.fn().mockReturnValue(5),
    getHumanResponseOnTimeout: vi.fn().mockReturnValue('continue'),
    logEscalationAnswer: vi.fn(),
    getReviewerModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    callReviewerModel: vi.fn().mockResolvedValue('The AI says: proceed'),
    generateBrowserValidationScript: vi.fn(async () => {
      throw new Error('Browser script generation is not configured in this unit fixture');
    }),
    incrementEscalationCount: vi.fn(),
    isAskHumanDisabled: vi.fn().mockReturnValue(false),
    reportPlan: vi.fn(),
    reportProgress: vi.fn(),
    reportTaskSummary: vi.fn(),
    readOperatorGuidance: vi.fn().mockReturnValue(null),
    acknowledgeOperatorGuidance: vi.fn(),
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
