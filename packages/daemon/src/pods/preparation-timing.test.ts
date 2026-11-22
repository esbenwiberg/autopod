import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_SIGNAL_NAMES,
  formatPreparationSummary,
  instrumentPrepareCommand,
  parseCacheSignals,
  parseStageTiming,
  prepareStageLabel,
  splitPrepareStages,
} from './preparation-timing.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

function runSh(script: string, cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile('/bin/sh', ['-c', script], { cwd, env: { PATH: process.env.PATH } }, (err, o, e) =>
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(o),
        stderr: String(e),
      }),
    );
  });
}

describe('splitPrepareStages', () => {
  it('splits plain top-level && chains', () => {
    expect(splitPrepareStages('npm ci && npm run bootstrap && node scripts/probe.mjs')).toEqual([
      'npm ci',
      'npm run bootstrap',
      'node scripts/probe.mjs',
    ]);
    expect(splitPrepareStages(`npm ci && echo "done ok" && test 'a' = 'a'`)).toEqual([
      'npm ci',
      'echo "done ok"',
      "test 'a' = 'a'",
    ]);
  });

  it.each([
    ['newline', 'npm ci\nnpm run build'],
    ['heredoc', 'cat <<EOF && npm ci'],
    ['comment', 'npm ci && npm test # trailing'],
    ['command substitution', 'npm ci && echo $(date && whoami)'],
    ['backticks', 'npm ci && echo `date`'],
    ['subshell', '(cd app && npm ci) && npm test'],
    ['group', '{ npm ci; } && npm test'],
    ['or-list', 'npm ci || npm install && npm test'],
    ['pipe', 'npm ci | tee log && npm test'],
    ['semicolon', 'npm ci; npm test && npm run x'],
    ['background', 'npm ci & npm test'],
    ['negation', '! false && npm ci'],
    ['line continuation', 'npm ci \\\n && npm test'],
    ['backslash escape', 'echo a\\&\\& && npm ci'],
    ['quoted &&', 'echo "a && b" && npm ci'],
    ['single-quoted &&', "sh -c 'a && b' && npm ci"],
    ['unbalanced quote', 'echo "a && npm ci'],
    ['empty segment', 'npm ci && && npm test'],
    ['leading &&', '&& npm ci'],
    ['trailing &&', 'npm ci &&'],
  ])('keeps %s as one unchanged stage', (_name, command) => {
    expect(splitPrepareStages(command)).toEqual([command]);
  });

  it('treats more than 20 stages as one', () => {
    const command = Array.from({ length: 21 }, (_, i) => `echo ${i}`).join(' && ');
    expect(splitPrepareStages(command)).toEqual([command]);
  });
});

describe('prepareStageLabel', () => {
  it('keeps leading ordinary words and withholds token-shaped or hidden words', () => {
    const hidden = new Set(['hiddenvalue']);
    expect(prepareStageLabel('npm ci --prefer-offline', 1, hidden)).toBe('npm ci');
    expect(prepareStageLabel('npm run bootstrap', 2, hidden)).toBe('npm run bootstrap');
    expect(prepareStageLabel('node scripts/probe.mjs --check', 3, hidden)).toBe(
      'node scripts/probe.mjs',
    );
    expect(prepareStageLabel('deploy Zx9qwertyuiop', 1, hidden)).toBe('deploy');
    expect(prepareStageLabel('tool ghp1234567890abcdef', 1, hidden)).toBe('tool');
    expect(prepareStageLabel('TOKEN=abc npm ci', 4, hidden)).toBe('stage 4');
    expect(prepareStageLabel('npm hiddenvalue', 1, hidden)).toBe('npm');
    expect(prepareStageLabel('"$PREPARE" run', 5, hidden)).toBe('stage 5');
  });
});

describe('instrumentPrepareCommand (executed with /bin/sh)', () => {
  async function compare(command: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'prep-timing-'));
    cleanups.push(dir);
    const timing = path.join(dir, 'timing');
    const plain = await runSh(`set -e\n${command}`, dir);
    const instrumented = await runSh(
      instrumentPrepareCommand(splitPrepareStages(command), timing),
      dir,
    );
    const markers = await readFile(timing, 'utf8').catch(() => '');
    return { plain, instrumented, markers };
  }

  it.each([
    'echo one && echo two >&2 && echo three',
    'echo one && false && echo never',
    'echo one && exit 7',
    'echo only',
    'exit 3',
    'false',
    'true && sh -c "exit 5"',
    'echo "a && b" && echo c',
    'printf "%s\\n" x | cat && false',
    'cat <<EOF\nheredoc body\nEOF\necho after',
    'echo first\nfalse\necho never',
    'echo $(echo sub && echo stitution) && echo z',
    'false || echo recovered && echo ok',
    'echo pre \\\n  continued && echo post',
    'trap "echo user-trap" EXIT && echo body',
    '! false && echo negated',
  ])('preserves exit status and output for %j', async (command) => {
    const { plain, instrumented, markers } = await compare(command);
    expect(instrumented.code).toBe(plain.code);
    expect(instrumented.stdout).toBe(plain.stdout);
    expect(instrumented.stderr).toBe(plain.stderr);
    if (!command.includes('trap')) expect(markers).toMatch(/^1 \d+(\.\d+)?$/m);
  });

  it('records a marker per started stage and an end marker', async () => {
    const { markers, instrumented } = await compare('echo a && false && echo c');
    expect(instrumented.code).not.toBe(0);
    expect(markers).toMatch(/^1 /m);
    expect(markers).toMatch(/^2 /m);
    expect(markers).not.toMatch(/^3 /m);
    expect(markers).toMatch(/^end /m);
  });

  it('never fails the command when the marker file cannot be written', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prep-timing-'));
    cleanups.push(dir);
    const script = instrumentPrepareCommand(
      ['echo a', 'echo b'],
      path.join(dir, 'missing-dir', 'timing'),
    );
    expect(await runSh(script, dir)).toEqual({ code: 0, stdout: 'a\nb\n', stderr: '' });
  });
});

describe('parseStageTiming', () => {
  const labels = ['npm ci', 'npm run bootstrap', 'node'];

  it('derives per-stage durations for a passing run', () => {
    const parsed = parseStageTiming('1 100.00\n2 801.50\n3 838.00\nend 842.25\n', labels, 0);
    expect(parsed).toEqual({
      stageTiming: 'measured',
      stages: [
        { index: 1, label: 'npm ci', durationMs: 701500, status: 'passed' },
        { index: 2, label: 'npm run bootstrap', durationMs: 36500, status: 'passed' },
        { index: 3, label: 'node', durationMs: 4250, status: 'passed' },
      ],
    });
  });

  it('marks the failing stage and the stages that never ran', () => {
    const parsed = parseStageTiming('1 10.00\n2 20.00\nend 25.50\n', labels, 1);
    expect(parsed.stages).toEqual([
      { index: 1, label: 'npm ci', durationMs: 10000, status: 'passed' },
      { index: 2, label: 'npm run bootstrap', durationMs: 5500, status: 'failed' },
      { index: 3, label: 'node', durationMs: null, status: 'not-run' },
    ]);
  });

  it('reports unavailable timing for missing or garbled markers', () => {
    for (const text of [null, '', 'garbage\n1 x\n']) {
      const parsed = parseStageTiming(text, labels, 0);
      expect(parsed.stageTiming).toBe('unavailable');
      expect(parsed.stages.every((stage) => stage.status === 'unknown')).toBe(true);
    }
  });
});

describe('cache signals and summary', () => {
  it('parses known caches and treats malformed output as unknown', () => {
    const lines = CACHE_SIGNAL_NAMES.map((_, i) => (i === 0 ? 'present' : 'absent')).join('\n');
    expect(parseCacheSignals(lines).signals[0]).toEqual({ name: 'npm-cache', state: 'present' });
    expect(parseCacheSignals('present').signals.every((s) => s.state === 'unknown')).toBe(true);
  });

  it('formats one activity line including a failed stage', () => {
    const line = formatPreparationSummary({
      status: 'failed',
      containerId: 'c',
      commandHash: null,
      configurationHash: null,
      source: null,
      exitCode: 1,
      timing: {
        totalMs: 742_000,
        commandMs: 740_000,
        preflightMs: 1200,
        sourceProbeMs: 900,
        stageTiming: 'measured',
        stages: [
          { index: 1, label: 'npm ci', durationMs: 701_000, status: 'passed' },
          { index: 2, label: 'npm run bootstrap', durationMs: 39_000, status: 'failed' },
          { index: 3, label: 'node', durationMs: null, status: 'not-run' },
        ],
      },
      cache: { signals: [{ name: 'npm-cache', state: 'absent' }] },
    });
    expect(line).toBe(
      'Repository preparation failed in 742s — [1] npm ci 701s · [2] npm run bootstrap 39s FAILED · [3] node not run; preflight 1.2s; probes 0.9s; caches before: npm-cache absent',
    );
  });
});
