import type { Pod, ValidationResult } from '@autopod/shared';

const COMPACT_LIMIT = 96;
const DETAIL_LIMIT = 180;

function cleanLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^task(?:\s*[:—-]\s*|\s+)/i, '')
    .replace(/`/g, '')
    .trim();
}

function taskLines(task: string): string[] {
  return task
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line && !/^(task|scope|tooling you can assume)$/i.test(line));
}

export function compactText(input: string, limit = COMPACT_LIMIT): string {
  const text = input.trim().replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function taskTitle(task: string): string {
  const lines = taskLines(task);
  return compactText(lines[0] ?? task, DETAIL_LIMIT);
}

export function taskPreview(task: string): string | null {
  const body = taskLines(task).slice(1).join(' ');

  return body ? compactText(body, COMPACT_LIMIT) : null;
}

export function progressLabel(pod: Pick<Pod, 'progress'>): string | null {
  if (!pod.progress) return null;
  const { currentPhase, totalPhases, phase, description } = pod.progress;
  const prefix = totalPhases > 0 ? `Phase ${currentPhase}/${totalPhases}` : 'Progress';
  return `${prefix}: ${compactText(phase || description, 72)}`;
}

export function progressDetail(pod: Pick<Pod, 'progress'>): string | null {
  if (!pod.progress) return null;
  const { description, phase } = pod.progress;
  return compactText(description || phase, DETAIL_LIMIT);
}

export function planLabel(pod: Pick<Pod, 'plan'>): string | null {
  if (!pod.plan) return null;
  return compactText(pod.plan.summary, 86);
}

export function validationLabel(result: ValidationResult | null): string | null {
  if (!result) return null;
  return `Validation #${result.attempt}: ${result.overall}`;
}

export function validationTone(result: ValidationResult | null): 'ok' | 'danger' | 'neutral' {
  if (!result) return 'neutral';
  return result.overall === 'pass' ? 'ok' : 'danger';
}
