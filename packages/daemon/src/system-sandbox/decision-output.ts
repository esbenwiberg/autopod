import type { PodsitterDecision, PodsitterRuntime } from '@autopod/shared';
import { podsitterDecisionSchema } from '@autopod/shared';

const MAX_OUTPUT_BYTES = 1_000_000;

export class DecisionOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionOutputError';
  }
}

export function parseSystemDecisionOutput(
  runtime: PodsitterRuntime,
  stdout: string,
): PodsitterDecision {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    throw new DecisionOutputError('Decision output exceeded the bounded output limit');
  }
  const payload = extractRuntimePayload(runtime, stdout);
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new DecisionOutputError('Provider returned malformed decision JSON');
  }
  const parsed = podsitterDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new DecisionOutputError(
      `Provider returned a decision that failed schema validation: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data as PodsitterDecision;
}

function extractRuntimePayload(runtime: PodsitterRuntime, stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new DecisionOutputError('Provider returned empty decision output');
  if (runtime === 'claude') {
    const envelope = parseObject(trimmed);
    return typeof envelope?.result === 'string' ? envelope.result : trimmed;
  }
  if (runtime === 'codex' || runtime === 'pi') {
    const lines = trimmed.split('\n').reverse();
    for (const line of lines) {
      const envelope = parseObject(line);
      const text =
        stringAt(envelope, ['result']) ??
        stringAt(envelope, ['content']) ??
        stringAt(envelope, ['item', 'text']) ??
        stringAt(envelope, ['message', 'content']);
      if (text) return text;
    }
  }
  const envelope = parseObject(trimmed);
  return typeof envelope?.result === 'string' ? envelope.result : trimmed;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringAt(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}
