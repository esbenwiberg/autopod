import type { ValidationWorkflowCalls } from './validation-workflow-ports.js';
export function createValidationTriggerCalls(
  receiver: ValidationWorkflowCalls,
): ValidationWorkflowCalls {
  return {
    triggerValidation: (...args) => receiver.triggerValidation(...args),
    assertCanRework: (...args) => receiver.assertCanRework(...args),
    approveSession: (...args) => receiver.approveSession(...args),
    consumeAgentEvents: (...args) => receiver.consumeAgentEvents(...args),
    handleCompletion: (...args) => receiver.handleCompletion(...args),
  };
}
