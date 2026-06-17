import type {
  PodBridge,
  SemanticValidationInput,
  SemanticValidationPhaseName,
  SemanticValidationResult,
} from '../pod-bridge.js';

export type ValidateSemanticsInput = SemanticValidationInput;
export type ValidateSemanticsResult = SemanticValidationResult;

const DEFAULT_SEMANTIC_PHASES: SemanticValidationPhaseName[] = [
  'health',
  'pages',
  'facts',
  'review',
];

export async function validateSemantics(
  podId: string,
  input: ValidateSemanticsInput,
  bridge: PodBridge,
): Promise<string> {
  const phases = input.phases?.length ? dedupe(input.phases) : DEFAULT_SEMANTIC_PHASES;

  for (const phase of phases) {
    if (!DEFAULT_SEMANTIC_PHASES.includes(phase)) {
      throw new Error(
        `Unknown semantic phase "${phase}". Valid phases: ${DEFAULT_SEMANTIC_PHASES.join(', ')}.`,
      );
    }
  }

  const result = await bridge.runSemanticValidation(podId, { ...input, phases });
  return JSON.stringify(result, null, 2);
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
