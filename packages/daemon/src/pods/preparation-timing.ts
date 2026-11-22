import { randomBytes } from 'node:crypto';
import type {
  RepositoryPreparationEvidence,
  RepositoryPreparationStageTiming,
} from '@autopod/shared';

/** More stages than this are treated as one: the evidence is meant to stay small. */
const MAX_STAGES = 20;
const MARKER_FUNCTION = '__autopod_prep_mark';

/**
 * Split a prepare command on top-level `&&` only when that split is certain.
 *
 * Anything that could make the split change what runs — newlines, heredocs, comments,
 * command substitution, backticks, subshells/groups, `||`, pipes, `;`, a lone `&`, `!`,
 * backslashes, `&&` inside quotes, unbalanced quotes or empty segments — yields one stage
 * containing the unchanged command.
 */
export function splitPrepareStages(command: string): string[] {
  const single = [command];
  if (/[\n\r\\`#();{}|!]/.test(command) || command.includes('<<') || command.includes('$('))
    return single;
  const stages: string[] = [];
  let quote: '"' | "'" | null = null;
  let current = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '&') return single;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '&') {
      if (command[i + 1] !== '&') return single;
      stages.push(current);
      current = '';
      i++;
      continue;
    }
    current += char;
  }
  if (quote) return single;
  stages.push(current);
  const trimmed = stages.map((stage) => stage.trim());
  if (trimmed.some((stage) => !stage) || trimmed.length > MAX_STAGES) return single;
  return trimmed;
}

/** Short lowercase words, or longer purely alphabetic lowercase words: never token-shaped. */
const SAFE_SHORT_WORD = /^[a-z][a-z0-9_.:@/+-]{0,6}$/;
const SAFE_LONG_WORD = /^[a-z][a-z_.:@/+-]{0,31}$/;

/** Leading non-secret words of a stage (at most three); `stage <n>` when none qualify. */
export function prepareStageLabel(segment: string, index: number, hidden: Set<string>): string {
  const words: string[] = [];
  for (const word of segment.trim().split(/\s+/)) {
    if (words.length >= 3) break;
    if (
      word.includes('=') ||
      hidden.has(word) ||
      !(SAFE_SHORT_WORD.test(word) || SAFE_LONG_WORD.test(word))
    )
      break;
    words.push(word);
  }
  return words.length ? words.join(' ') : `stage ${index}`;
}

export function preparationTimingPath(): string {
  return `/tmp/.autopod-prep-timing-${randomBytes(12).toString('hex')}`;
}

/**
 * Build `set -e` + the configured command with stage markers that cannot alter what runs.
 *
 * The marker function always returns 0, writes only `<index> <uptime>` to its own file and
 * silences its own errors, so chaining it with `&&` keeps the command's control flow and
 * exit status. A single stage gets its marker on a separate line before the unchanged
 * command. The EXIT trap records the end time without changing the exit status.
 */
export function instrumentPrepareCommand(stages: string[], timingPath: string): string {
  const mark = [
    `${MARKER_FUNCTION}() { { read -r __autopod_prep_up __autopod_prep_rest </proc/uptime &&`,
    ` printf '%s %s\\n' "$1" "$__autopod_prep_up" >>'${timingPath}'; } 2>/dev/null || :; }`,
  ].join('');
  const preamble = ['set -e', mark, `trap '${MARKER_FUNCTION} end' EXIT`];
  if (stages.length <= 1) return [...preamble, `${MARKER_FUNCTION} 1`, stages[0] ?? ''].join('\n');
  return [
    ...preamble,
    stages.map((stage, i) => `${MARKER_FUNCTION} ${i + 1} && ${stage}`).join(' && '),
  ].join('\n');
}

/** Map marker lines to per-stage durations. Unreadable markers make timing unavailable. */
export function parseStageTiming(
  text: string | null,
  labels: string[],
  exitCode: number | null,
): { stageTiming: 'measured' | 'unavailable'; stages: RepositoryPreparationStageTiming[] } {
  const marks = new Map<string, number>();
  for (const line of (text ?? '').split('\n')) {
    const match = /^(\d{1,2}|end) (\d+(?:\.\d+)?)$/.exec(line.trim());
    if (match && !marks.has(match[1] as string))
      marks.set(match[1] as string, Number(match[2]) * 1000);
  }
  const measured = marks.has('1');
  const end = marks.get('end');
  const stages = labels.map((label, i): RepositoryPreparationStageTiming => {
    const index = i + 1;
    const start = marks.get(String(index));
    if (!measured) return { index, label, durationMs: null, status: 'unknown' };
    if (start === undefined) return { index, label, durationMs: null, status: 'not-run' };
    const next = marks.get(String(index + 1));
    const stop = next ?? end;
    const durationMs = stop === undefined ? null : Math.max(0, Math.round(stop - start));
    let status: RepositoryPreparationStageTiming['status'];
    if (next !== undefined) status = 'passed';
    else if (exitCode === 0) status = index === labels.length ? 'passed' : 'unknown';
    else status = exitCode === null ? 'unknown' : 'failed';
    return { index, label, durationMs, status };
  });
  return { stageTiming: measured ? 'measured' : 'unavailable', stages };
}

/** Known package/tool caches. Order matches `CACHE_SIGNAL_SCRIPT` output. */
export const CACHE_SIGNAL_NAMES = [
  'npm-cache',
  'pnpm-store',
  'yarn-cache',
  'playwright-browsers',
  'pip-cache',
  'nuget-packages',
  'workdir-node_modules',
] as const;

/** Read-only: prints present/absent per cache (non-empty directory), in name order. */
export const CACHE_SIGNAL_SCRIPT = [
  'for p in "$HOME/.npm/_cacache" "$HOME/.local/share/pnpm/store" "$HOME/.cache/yarn"',
  ' "$HOME/.cache/ms-playwright" "$HOME/.cache/pip" "$HOME/.nuget/packages" node_modules; do',
  ' if [ -d "$p" ] && [ -n "$(ls -A "$p" 2>/dev/null | head -n 1)" ]; then echo present;',
  ' else echo absent; fi; done',
].join('');

export function parseCacheSignals(
  stdout: string | null,
): NonNullable<RepositoryPreparationEvidence['cache']> {
  const lines = (stdout ?? '').trim().split('\n');
  const valid =
    lines.length === CACHE_SIGNAL_NAMES.length &&
    lines.every((line) => line === 'present' || line === 'absent');
  return {
    signals: CACHE_SIGNAL_NAMES.map((name, i) => ({
      name,
      state: valid ? (lines[i] as 'present' | 'absent') : 'unknown',
    })),
  };
}

function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '?';
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** One activity line for pod logs, e.g. `… passed in 742s — [1] npm ci 701s · …`. */
export function formatPreparationSummary(evidence: RepositoryPreparationEvidence): string {
  const timing = evidence.timing;
  const parts = [`Repository preparation ${evidence.status}`];
  if (timing) parts[0] += ` in ${seconds(timing.totalMs)}`;
  if (evidence.reuse?.decision === 'reused') parts.push('reused prepared dependencies');
  else if (timing?.stages.length) {
    parts.push(
      timing.stages
        .map(
          (stage) =>
            `[${stage.index}] ${stage.label} ${
              stage.status === 'not-run'
                ? 'not run'
                : `${seconds(stage.durationMs)}${stage.status === 'failed' ? ' FAILED' : ''}`
            }`,
        )
        .join(' · ') +
        (timing.stageTiming === 'unavailable'
          ? ` (stage timing unavailable; command ${seconds(timing.commandMs)})`
          : ''),
    );
  }
  const extras: string[] = [];
  if (timing?.preflightMs !== undefined && timing.preflightMs !== null)
    extras.push(`preflight ${seconds(timing.preflightMs)}`);
  if (timing?.sourceProbeMs !== null && timing?.sourceProbeMs !== undefined)
    extras.push(`probes ${seconds(timing.sourceProbeMs)}`);
  const known = evidence.cache?.signals.filter((signal) => signal.state !== 'unknown') ?? [];
  if (known.length)
    extras.push(`caches before: ${known.map((s) => `${s.name} ${s.state}`).join(', ')}`);
  return `${parts.join(' — ')}${extras.length ? `; ${extras.join('; ')}` : ''}`;
}
