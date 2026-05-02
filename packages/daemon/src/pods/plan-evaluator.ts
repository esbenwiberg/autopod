import type { AcDefinition, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';

const PLAN_EVAL_TIMEOUT = 60_000;

/**
 * Evaluates an agent's reported plan against the pod's acceptance criteria.
 * Returns a feedback string to queue as a nudge, or null if evaluation was
 * skipped (no AC, no reviewer model).
 *
 * Intended to be fire-and-forget — the caller should not await this directly
 * in the hot path.
 */
export async function evaluatePlanAgainstAc(
  summary: string,
  steps: string[],
  acceptanceCriteria: AcDefinition[],
  profile: Profile,
  log?: Logger,
): Promise<string | null> {
  if (!acceptanceCriteria.length) return null;

  const reviewerModel = profile.reviewerModel || profile.defaultModel || 'claude-sonnet-4-5';

  const acList = acceptanceCriteria
    .map((ac, i) => `${i + 1}. [${ac.type}] Test: ${ac.test} / Pass: ${ac.pass} / Fail: ${ac.fail}`)
    .join('\n');

  const stepsText = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt = `You are a harness pre-evaluation assistant. An agent has reported its implementation plan. Evaluate whether the plan addresses all acceptance criteria.

## Implementation Plan

**Summary:** ${summary}

**Steps:**
${stepsText}

## Acceptance Criteria

${acList}

## Your Task

For each acceptance criterion, briefly assess whether the plan covers it. Be terse — one line per concern. Flag gaps, ambiguities, or risks only. If the plan fully covers all criteria, respond with "Plan covers all acceptance criteria."

Respond in plain text, no JSON, no markdown headers. Maximum 10 lines.`;

  try {
    const { stdout } = await runClaudeCli({
      model: reviewerModel,
      input: prompt,
      timeout: PLAN_EVAL_TIMEOUT,
    });
    const feedback = stdout.trim();
    if (!feedback || feedback.toLowerCase().includes('covers all acceptance criteria')) return null;
    return feedback;
  } catch (err) {
    log?.warn({ err }, 'Plan evaluation against AC failed');
    return null;
  }
}
