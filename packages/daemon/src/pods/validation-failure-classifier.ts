import type { ValidationResult } from '@autopod/shared';

export type ValidationFailureKind = 'infra' | 'code';

export interface ValidationFailureClassification {
  kind: ValidationFailureKind;
  phase: string;
  signature: string;
  reason: string;
}

const MISSING_TOOL_PATTERNS: Array<{ signature: string; regex: RegExp }> = [
  {
    signature: 'node-tool-not-found',
    regex:
      /(?:^|\n|sh:\s*\d+:\s*)(tsc|vite|vitest|jest|playwright|tsx|webpack|next|ng|eslint|biome|pnpm|npm|yarn): not found\b/i,
  },
  {
    signature: 'playwright-package-missing',
    regex: /(?:ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)).*['"]?@playwright\/test['"]?/is,
  },
  {
    signature: 'playwright-test-package-missing',
    regex: /Package subpath .*@playwright\/test|@playwright\/test.*(?:not found|missing)/is,
  },
];

const INFRA_PATTERNS: Array<{ signature: string; regex: RegExp }> = [
  {
    signature: 'native-binding-mismatch',
    regex:
      /NODE_MODULE_VERSION|node-gyp|better-sqlite3|better_sqlite3\.node|binding\.node|prebuild-install|node-pre-gyp/i,
  },
  {
    signature: 'oom-killed',
    regex: /OOM-killed|exit 137|(?:^|\n)Killed\s*$/i,
  },
  {
    signature: 'missing-node-modules',
    regex:
      /Cannot find module ['"][^'"]*node_modules|Cannot find package ['"][^'"]+['"].*node_modules/is,
  },
];

export function classifyValidationFailure(
  result: ValidationResult,
): ValidationFailureClassification | null {
  if (result.overall !== 'fail') return null;

  const reviewClassification = classifyReviewFailure(result);
  if (reviewClassification) return reviewClassification;

  const phaseOutputs: Array<{ phase: string; output: string }> = [
    { phase: 'setup', output: result.setup?.output ?? '' },
    { phase: 'lint', output: result.lint?.output ?? '' },
    { phase: 'sast', output: result.sast?.output ?? '' },
    { phase: 'build', output: result.smoke.build.output },
    {
      phase: 'test',
      output: [result.test?.stdout, result.test?.stderr].filter(Boolean).join('\n'),
    },
    { phase: 'health', output: result.smoke.health.startOutput ?? '' },
    {
      phase: 'facts',
      output:
        result.factValidation?.results
          .map((fact) =>
            [fact.reasoning, fact.command, fact.stdout, fact.stderr].filter(Boolean).join('\n'),
          )
          .join('\n\n') ?? '',
    },
  ];

  for (const { phase, output } of phaseOutputs) {
    const classification = classifyOutput(phase, output);
    if (classification) return classification;
  }

  return null;
}

function classifyReviewFailure(result: ValidationResult): ValidationFailureClassification | null {
  if (result.taskReview !== null) return null;
  if (result.reviewSkipKind !== 'review-timeout' && result.reviewSkipKind !== 'review-failed') {
    return null;
  }

  const reason = result.reviewSkipReason ?? 'Review did not produce a result.';
  if (result.reviewSkipKind === 'review-timeout' || /timed out after \d+ms/i.test(reason)) {
    return {
      kind: 'infra',
      phase: 'review',
      signature: 'review-timeout',
      reason,
    };
  }

  return {
    kind: 'infra',
    phase: 'review',
    signature: 'review-infrastructure-failure',
    reason,
  };
}

function classifyOutput(phase: string, output: string): ValidationFailureClassification | null {
  const text = output.trim();
  if (!text) return null;

  for (const pattern of [...MISSING_TOOL_PATTERNS, ...INFRA_PATTERNS]) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    return {
      kind: 'infra',
      phase,
      signature: pattern.signature,
      reason: match[0].slice(0, 500),
    };
  }

  return null;
}
