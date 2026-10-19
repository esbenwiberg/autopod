export function createValidationWorkflowState() {
  const validationAbortControllers = new Map<string, AbortController>();
  const attemptExtensionRuns = new Map<string, Promise<void>>();
  const pendingUpdateFromBaseIntents = new Set<string>();
  return { validationAbortControllers, attemptExtensionRuns, pendingUpdateFromBaseIntents };
}
