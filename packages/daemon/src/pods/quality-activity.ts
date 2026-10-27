import { posix } from 'node:path';
import type { AgentEvent, AgentFileChangeEvent, AgentToolUseEvent } from '@autopod/shared';

export type QualityActivity =
  | {
      kind: 'inspection';
      path: string;
      source: 'native-tool' | 'shell-command';
      callId?: string;
    }
  | {
      kind: 'mutation';
      path: string;
      action: 'create' | 'modify' | 'delete' | 'write';
      source: 'file-change' | 'native-tool';
      callId?: string;
    };

export interface QualityActivityEvidence {
  activities: QualityActivity[];
  /** An inspection-looking shell command existed, but its paths were not provable. */
  ambiguousInspection: boolean;
}

const WORKSPACE_ROOT = '/workspace';
// After a single `|` these programs only filter stdin; `| xargs cat` still reads files.
const INSPECTION_AFTER_CONTROL =
  /(?:^|&&|\|\||[;(`\n])\s*(?:cat|head|tail|sed|rg|grep)(?:\s|$)|\|\s*xargs\b[^|;&]*\b(?:cat|head|tail|sed|rg|grep)\b/;
const INSPECTION_STAGE = /^(?:xargs(?:\s+-\S+)*\s+)?(?:cat|head|tail|sed|rg|grep)(?:\s|$)/;
/** Builtins/assignments that can change what later commands resolve to or where they run. */
const SHELL_STATE_COMMAND =
  /^(?:(?:export|declare|typeset|local|readonly)(?:\s+-\S+)*\s+)?(?:PATH|CDPATH|IFS|BASH_ENV|ENV)=|^(?:pushd|popd|source|\.|eval|exec|alias|shopt|unset|hash|enable|builtin|command|function|trap)(?:\s|$)/;
const STDERR_REDIRECT = /(^|\s)2>(?:&1|\s*\/dev\/null)(?=\s|$)/g;
const SHELL_LOGIN_INSPECTION =
  /^(?:\/bin\/)?(?:bash|sh)\s+-lc\s+['"]?\s*(?:cat|head|tail|sed|rg|grep)(?:\s|$)/;
const EXPANDING_DOUBLE_QUOTE_META = new Set(['$', '`', '\n', '\r']);
const SHELL_META = new Set([
  ';',
  '|',
  '&',
  '<',
  '>',
  '`',
  '$',
  '\n',
  '\r',
  '(',
  ')',
  '{',
  '}',
  '*',
  '?',
  '[',
  ']',
  '#',
  '~',
]);

export function normalizeQualityActivity(event: AgentEvent): QualityActivity[] {
  return normalizeQualityActivityEvidence(event).activities;
}

export function normalizeQualityActivityEvidence(event: AgentEvent): QualityActivityEvidence {
  if (event.type === 'file_change') {
    return { activities: normalizeFileChange(event), ambiguousInspection: false };
  }
  if (event.type !== 'tool_use') return { activities: [], ambiguousInspection: false };

  const callId = stringInput(event, 'call_id') ?? stringInput(event, 'callId');
  const native = normalizeNativeTool(event, callId);
  if (native.length > 0 || event.tool !== 'Bash') {
    return { activities: native, ambiguousInspection: false };
  }

  const command = stringInput(event, 'command');
  const cwd = stringInput(event, 'cwd') ?? stringInput(event, 'workdir') ?? WORKSPACE_ROOT;
  const argvEvidence = structuredShellEvidence(event, cwd);
  const shellEvidence =
    argvEvidence ?? (command ? evaluateShellScript(command, cwd) : { paths: [], ambiguous: false });
  return {
    activities: shellEvidence.paths.map((path) => ({
      kind: 'inspection',
      path,
      source: 'shell-command',
      ...(callId && { callId }),
    })),
    ambiguousInspection: shellEvidence.ambiguous,
  };
}

/**
 * Only an argv array can prove that a shell script was supplied as one `-lc`
 * argument. Never try to recover that boundary from the display command.
 */
function structuredShellEvidence(
  event: AgentToolUseEvent,
  cwd: string,
): { paths: string[]; ambiguous: boolean } | null {
  if (!Object.hasOwn(event.input, 'argv')) return null;
  const argv = stringArrayInput(event, 'argv');
  if (argv === null) {
    return { paths: [], ambiguous: true };
  }
  if (argv.length === 0) return { paths: [], ambiguous: true };
  const [program, flag, script, ...rest] = argv;
  const isShell =
    program === 'bash' || program === '/bin/bash' || program === 'sh' || program === '/bin/sh';
  if (isShell && flag === '-lc' && typeof script === 'string' && rest.length === 0) {
    return evaluateShellScript(script, cwd, true);
  }
  // A shell invocation with any other argv shape cannot prove where its script
  // begins or whether it is read-only. Do not fall back to its display command.
  if (isShell) return { paths: [], ambiguous: true };
  return inspectedArgvEvidence(argv, cwd);
}

function inspectedArgvEvidence(
  argv: string[],
  cwd: string,
): { paths: string[]; ambiguous: boolean } {
  if (argv.some(hasShellMeta)) {
    return { paths: [], ambiguous: isInspectionProgram(argv[0]) };
  }
  // Only the explicit shell wrappers above are supported absolute executables.
  // Treat every other absolute program as unresolved rather than silently
  // counting a zero-read session as complete evidence.
  if (argv[0]?.startsWith('/')) return { paths: [], ambiguous: true };
  const evidence = inspectedTokensEvidence(argv, cwd);
  if (evidence.resolved || evidence.ambiguous) {
    return { paths: evidence.paths, ambiguous: evidence.ambiguous };
  }
  return {
    paths: [],
    ambiguous:
      argv.some((argument) => looksLikeInspection(argument)) || isInspectionProgram(argv[0]),
  };
}

function hasShellMeta(argument: string): boolean {
  return [...argument].some((character) => SHELL_META.has(character));
}

export function canonicalRepositoryPath(
  rawPath: string,
  cwd: string = WORKSPACE_ROOT,
): string | null {
  if (rawPath.includes('\0') || cwd.includes('\0')) return null;
  const normalizedInput = rawPath.replaceAll('\\', '/');
  const normalizedCwd = cwd.replaceAll('\\', '/');
  let relative: string;

  if (normalizedInput === WORKSPACE_ROOT) return null;
  if (normalizedInput.startsWith(`${WORKSPACE_ROOT}/`)) {
    relative = normalizedInput.slice(WORKSPACE_ROOT.length + 1);
  } else if (normalizedInput.startsWith('/')) {
    return null;
  } else if (normalizedCwd === WORKSPACE_ROOT) {
    relative = normalizedInput;
  } else if (normalizedCwd.startsWith(`${WORKSPACE_ROOT}/`)) {
    relative = `${normalizedCwd.slice(WORKSPACE_ROOT.length + 1)}/${normalizedInput}`;
  } else {
    return null;
  }

  const canonical = posix.normalize(relative);
  if (
    canonical === '.' ||
    canonical === '..' ||
    canonical.startsWith('../') ||
    posix.isAbsolute(canonical)
  ) {
    return null;
  }
  return canonical.replace(/^\.\//, '');
}

function normalizeFileChange(event: AgentFileChangeEvent): QualityActivity[] {
  const path = canonicalRepositoryPath(event.path);
  if (!path) return [];
  return [{ kind: 'mutation', path, action: event.action, source: 'file-change' }];
}

function normalizeNativeTool(
  event: AgentToolUseEvent,
  callId: string | undefined,
): QualityActivity[] {
  const tool = event.tool.toLowerCase();
  if (!['read', 'edit', 'write'].includes(tool)) return [];
  const rawPath =
    stringInput(event, 'path') ?? stringInput(event, 'file_path') ?? stringInput(event, 'filePath');
  if (!rawPath) return [];
  const path = canonicalRepositoryPath(rawPath, stringInput(event, 'cwd') ?? WORKSPACE_ROOT);
  if (!path) return [];
  if (tool === 'read') {
    return [{ kind: 'inspection', path, source: 'native-tool', ...(callId && { callId }) }];
  }
  return [
    {
      kind: 'mutation',
      path,
      action: tool === 'edit' ? 'modify' : 'write',
      source: 'native-tool',
      ...(callId && { callId }),
    },
  ];
}

function stringArrayInput(event: AgentToolUseEvent, key: string): string[] | null {
  const value = event.input[key];
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : null;
}

type ShellEvidence = { paths: string[]; ambiguous: boolean };

interface ShellSegment {
  text: string;
  /** Runs only after an earlier `||` command failed, so it cannot prove a read happened. */
  conditional: boolean;
  /** Takes inline heredoc data on stdin; never a repository-file read. */
  heredoc: boolean;
}

interface ShellScan {
  segments: ShellSegment[];
  /** Script text from the first construct that cannot be bounded safely (`$(`, backticks, groups). */
  opaqueTail: string | null;
}

/**
 * Evaluate a shell script one `;` / `&&` / `||` / newline segment at a time. A read is
 * credited only when its own pipeline proves which repository file was displayed, so an
 * unrelated or unprovable segment no longer erases reads proven elsewhere in the command.
 * Anything the scanner cannot bound remains ambiguous when it looks like an inspection.
 */
function evaluateShellScript(
  script: string,
  cwd: string,
  structuredWrapper = false,
): ShellEvidence {
  const scan = scanShellScript(script);
  const paths = new Set<string>();
  let ambiguous = false;
  let currentCwd: string | null = cwd;

  for (let index = 0; index < scan.segments.length; index += 1) {
    const segment = scan.segments[index];
    const text = segment?.text.trim() ?? '';
    if (!segment || !text || segment.heredoc) continue;

    if (SHELL_STATE_COMMAND.test(text)) {
      // PATH, alias, function, or sourced-script changes make every later segment
      // unprovable. Stop crediting and judge the remainder conservatively.
      const remainder = [
        ...scan.segments.slice(index + 1).map((later) => later.text),
        ...(scan.opaqueTail === null ? [] : [scan.opaqueTail]),
      ].join('\n');
      return { paths: [...paths], ambiguous: ambiguous || looksLikeInspection(remainder) };
    }

    if (/^cd(?:\s|$)/.test(text)) {
      currentCwd = resolveCd(text, currentCwd);
      continue;
    }

    const evidence = pipelineEvidence(text, currentCwd);
    if (segment.conditional) {
      ambiguous ||= evidence.ambiguous || evidence.paths.length > 0;
    } else {
      for (const path of evidence.paths) paths.add(path);
      ambiguous ||= evidence.ambiguous;
    }
  }

  if (scan.opaqueTail !== null) {
    ambiguous ||= structuredWrapper || looksLikeInspection(scan.opaqueTail);
  }
  return { paths: [...paths], ambiguous };
}

/** Split a script into top-level command segments without interpreting anything. */
function scanShellScript(script: string): ShellScan {
  const segments: ShellSegment[] = [];
  const pendingHeredocs: HeredocDelimiter[] = [];
  let current = '';
  let conditional = false;
  let heredoc = false;
  let quote: "'" | '"' | null = null;
  let segmentStart = 0;

  const push = (): void => {
    segments.push({ text: current, conditional, heredoc });
    current = '';
    heredoc = false;
  };
  const opaque = (): ShellScan => ({ segments, opaqueTail: script.slice(segmentStart) });

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] ?? '';
    const next = script[index + 1] ?? '';

    if (quote === "'") {
      current += character;
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '`' || (character === '$' && next === '(')) return opaque();
      if (character === '\\') {
        current += character + next;
        index += 1;
        continue;
      }
      current += character;
      if (character === '"') quote = null;
      continue;
    }

    if (character === '\\') {
      if (next !== '\n') current += character + next;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '#' && (current === '' || /\s$/.test(current))) {
      while (index + 1 < script.length && script[index + 1] !== '\n') index += 1;
      continue;
    }
    if ('`(){}'.includes(character)) return opaque();
    if (character === '<' && next === '<' && script[index + 2] !== '<') {
      const parsed = parseHeredocDelimiter(script, index + 2);
      if (!parsed) return opaque();
      pendingHeredocs.push(parsed.heredoc);
      heredoc = true;
      current += script.slice(index, parsed.end);
      index = parsed.end - 1;
      continue;
    }
    if (character === ';' || character === '\n' || character === '\r') {
      if (character === ';' && next === ';') return opaque();
      push();
      conditional = false;
      if (character === '\n' && pendingHeredocs.length > 0) {
        const end = skipHeredocBodies(script, index + 1, pendingHeredocs);
        pendingHeredocs.length = 0;
        // An unterminated body is inline data through the end of the script.
        if (end === null) return { segments, opaqueTail: null };
        index = end - 1;
      }
      segmentStart = index + 1;
      continue;
    }
    if (character === '&' && next === '&') {
      push();
      index += 1;
      segmentStart = index + 1;
      continue;
    }
    if (character === '|' && next === '|') {
      push();
      conditional = true;
      index += 1;
      segmentStart = index + 1;
      continue;
    }
    if (character === '&') {
      const previous = current.at(-1);
      if (previous === '>' || previous === '<' || next === '>') {
        current += character;
        continue;
      }
      // Background job: the next command runs unconditionally.
      push();
      conditional = false;
      segmentStart = index + 1;
      continue;
    }
    current += character;
  }

  if (quote) return opaque();
  push();
  return { segments, opaqueTail: null };
}

interface HeredocDelimiter {
  delimiter: string;
  stripTabs: boolean;
}

function parseHeredocDelimiter(
  script: string,
  start: number,
): { heredoc: HeredocDelimiter; end: number } | null {
  let index = start;
  let stripTabs = false;
  if (script[index] === '-') {
    stripTabs = true;
    index += 1;
  }
  while (script[index] === ' ' || script[index] === '\t') index += 1;
  let delimiter = '';
  while (index < script.length) {
    const character = script[index] ?? '';
    if (character === "'" || character === '"') {
      const close = script.indexOf(character, index + 1);
      if (close === -1) return null;
      delimiter += script.slice(index + 1, close);
      index = close + 1;
      continue;
    }
    if (character === '\\') {
      delimiter += script[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (/[\s;&|<>()]/.test(character)) break;
    delimiter += character;
    index += 1;
  }
  return delimiter ? { heredoc: { delimiter, stripTabs }, end: index } : null;
}

/** Returns the index after the last heredoc terminator, or null when a body never ends. */
function skipHeredocBodies(
  script: string,
  start: number,
  pending: HeredocDelimiter[],
): number | null {
  let position = start;
  for (const { delimiter, stripTabs } of pending) {
    for (;;) {
      if (position >= script.length) return null;
      const newline = script.indexOf('\n', position);
      const lineEnd = newline === -1 ? script.length : newline;
      let line = script.slice(position, lineEnd).replace(/\r$/, '');
      if (stripTabs) line = line.replace(/^\t+/, '');
      position = newline === -1 ? script.length : newline + 1;
      if (line === delimiter) break;
    }
  }
  return position;
}

function resolveCd(text: string, cwd: string | null): string | null {
  const tokens = tokenizeShell(text);
  // `cd`, `cd -`, options, or expansions leave the directory unknown.
  if (!tokens || tokens.length !== 2) return null;
  const target = tokens[1] ?? '';
  if (!target || target.startsWith('-') || hasUnsafeShellExpansion(target)) return null;
  const normalizedTarget = target.replaceAll('\\', '/');
  if (normalizedTarget.startsWith('/')) return posix.normalize(normalizedTarget);
  if (cwd === null || !cwd.startsWith('/')) return null;
  return posix.normalize(`${cwd.replaceAll('\\', '/')}/${normalizedTarget}`);
}

/**
 * A pipeline proves a read only when its first stage is a provable inspection and every
 * later stage merely narrows what is displayed (`| head`, `| grep pattern`, ...).
 */
function pipelineEvidence(text: string, cwd: string | null): ShellEvidence {
  const stages = splitPipeline(text);
  const [source, ...filters] = stages ?? [];
  if (!stages || source === undefined) {
    return { paths: [], ambiguous: looksLikeInspectionStage(text) };
  }
  const sourceEvidence = stageEvidence(source, cwd);
  const unsafeFilters = filters.filter((filter) => !isDisplayFilter(filter));
  if (unsafeFilters.length > 0) {
    return {
      paths: [],
      ambiguous: sourceEvidence.inspection || unsafeFilters.some(looksLikeInspectionStage),
    };
  }
  return { paths: sourceEvidence.paths, ambiguous: sourceEvidence.ambiguous };
}

function stageEvidence(stage: string, cwd: string | null): ShellEvidence & { inspection: boolean } {
  const text = withoutStderrRedirects(stage);
  const inspection = looksLikeInspectionStage(text);
  if (SHELL_LOGIN_INSPECTION.test(text)) return { paths: [], ambiguous: true, inspection };
  if (hasUnsafeShellExpansion(text)) return { paths: [], ambiguous: inspection, inspection };
  const tokens = tokenizeShell(text);
  if (!tokens) return { paths: [], ambiguous: inspection, inspection };
  const evidence = inspectedTokensEvidence(tokens, cwd);
  return { paths: evidence.paths, ambiguous: evidence.ambiguous, inspection };
}

/** Quote-aware split on single `|`. `||` was already handled by the segment scanner. */
function splitPipeline(text: string): string[] | null {
  const stages: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"') {
        current += text[index + 1] ?? '';
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '\\') {
      current += character + (text[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '|') {
      if (text[index + 1] === '&') return null;
      stages.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (quote) return null;
  stages.push(current.trim());
  return stages.every((stage) => stage.length > 0) ? stages : null;
}

/** Stages that only narrow already-displayed stdin and read no files of their own. */
function isDisplayFilter(stage: string): boolean {
  const tokens = tokenizeShell(withoutStderrRedirects(stage));
  if (!tokens || tokens.length === 0) return false;
  const [program, ...args] = tokens;
  switch (program) {
    case 'head':
    case 'tail':
      return isLineCountOnly(args);
    case 'grep':
    case 'rg':
      return isPatternOnly(args);
    case 'sed':
      return args.length === 2 && args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] ?? '');
    case 'cat':
    case 'nl':
    case 'sort':
    case 'uniq':
      return args.every(
        (arg) => arg.startsWith('-') && !arg.startsWith('-o') && !arg.startsWith('--output'),
      );
    default:
      return false;
  }
}

function isLineCountOnly(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (['-n', '--lines', '-c', '--bytes'].includes(arg)) {
      index += 1;
      if (!/^[+-]?\d+$/.test(args[index] ?? '')) return false;
      continue;
    }
    if (/^-[nc][+-]?\d+$/.test(arg) || /^-\d+$/.test(arg)) continue;
    if (/^--(?:lines|bytes)=[+-]?\d+$/.test(arg)) continue;
    return false;
  }
  return true;
}

function isPatternOnly(args: string[]): boolean {
  const valueFlags = new Set([
    '-e',
    '--regexp',
    '-m',
    '--max-count',
    '-A',
    '-B',
    '-C',
    '--after-context',
    '--before-context',
    '--context',
  ]);
  let positional = 0;
  let explicitPattern = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      positional += args.length - index - 1;
      break;
    }
    if (valueFlags.has(arg)) {
      if (arg === '-e' || arg === '--regexp') explicitPattern = true;
      index += 1;
      if (args[index] === undefined) return false;
      continue;
    }
    if (arg.startsWith('--')) {
      if (arg.startsWith('--regexp=')) explicitPattern = true;
      // Recursive and pattern-file modes read files instead of stdin.
      if (/^--(?:recursive|dereference-recursive|file|files)\b/.test(arg)) return false;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (/[rRf]/.test(arg.slice(1))) return false;
      continue;
    }
    positional += 1;
  }
  return explicitPattern ? positional === 0 : positional === 1;
}

function withoutStderrRedirects(text: string): string {
  return text.replace(STDERR_REDIRECT, '$1').trim();
}

function hasUnsafeShellExpansion(command: string): boolean {
  return [...command].some((character) => ['*', '?', '[', ']', '~'].includes(character));
}

type OperandPath = { kind: 'repo'; path: string } | { kind: 'external' } | { kind: 'unknown' };

/**
 * Paths that lexically resolve outside the workspace (task specs, /tmp notes) are proven
 * non-repository reads: neither credited nor ambiguous. The workspace root itself and
 * unresolvable relative paths stay unknown.
 */
function classifyOperandPath(rawPath: string, cwd: string | null): OperandPath {
  if (rawPath.includes('\0')) return { kind: 'unknown' };
  const input = rawPath.replaceAll('\\', '/');
  let absolute: string;
  if (input.startsWith('/')) {
    absolute = posix.normalize(input);
  } else if (cwd === null || !cwd.startsWith('/')) {
    return { kind: 'unknown' };
  } else {
    absolute = posix.normalize(`${cwd.replaceAll('\\', '/')}/${input}`);
  }
  if (absolute === WORKSPACE_ROOT || absolute === `${WORKSPACE_ROOT}/`) return { kind: 'unknown' };
  if (!absolute.startsWith(`${WORKSPACE_ROOT}/`)) return { kind: 'external' };
  const path = canonicalRepositoryPath(absolute);
  return path ? { kind: 'repo', path } : { kind: 'unknown' };
}

function inspectedTokensEvidence(
  tokens: string[],
  cwd: string | null,
): ShellEvidence & { resolved: boolean } {
  if (tokens.length < 2) return { paths: [], ambiguous: false, resolved: false };
  const [program, ...args] = tokens;
  let operands: string[];

  switch (program) {
    case 'cat':
      operands = simpleFileOperands(
        args,
        new Set(['-A', '-b', '-e', '-E', '-n', '-s', '-t', '-T', '-u', '-v']),
      );
      break;
    case 'head':
    case 'tail':
      operands = headTailOperands(args);
      break;
    case 'sed':
      operands = sedOperands(args);
      break;
    case 'rg':
    case 'grep':
      operands = ripgrepOperands(args);
      break;
    default:
      return { paths: [], ambiguous: false, resolved: false };
  }

  if (operands.length === 0 || operands.some((operand) => operand === '-')) {
    return { paths: [], ambiguous: isInspectionProgram(program), resolved: false };
  }
  const classified = operands.map((operand) => classifyOperandPath(operand, cwd));
  if (classified.some((operand) => operand.kind === 'unknown')) {
    return { paths: [], ambiguous: true, resolved: false };
  }
  const paths = classified.flatMap((operand) => (operand.kind === 'repo' ? [operand.path] : []));
  return { paths: [...new Set(paths)], ambiguous: false, resolved: true };
}

function isInspectionProgram(program: string | undefined): boolean {
  return ['cat', 'head', 'tail', 'sed', 'rg', 'grep'].includes(program ?? '');
}

function looksLikeInspection(command: string): boolean {
  return INSPECTION_AFTER_CONTROL.test(command) || SHELL_LOGIN_INSPECTION.test(command);
}

function looksLikeInspectionStage(stage: string): boolean {
  const text = stage.trim();
  return INSPECTION_STAGE.test(text) || SHELL_LOGIN_INSPECTION.test(text);
}

function tokenizeShell(command: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let active = false;

  for (const character of command) {
    if (escaped) {
      token += character;
      active = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else {
        if (quote === '"' && EXPANDING_DOUBLE_QUOTE_META.has(character)) return null;
        token += character;
      }
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
    } else if (SHELL_META.has(character)) {
      return null;
    } else if (/\s/.test(character)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
    } else {
      token += character;
      active = true;
    }
  }
  if (escaped || quote) return null;
  if (active) tokens.push(token);
  return tokens;
}

function simpleFileOperands(args: string[], flags: Set<string>): string[] {
  const operands: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-')) {
      if (!flags.has(arg)) return [];
    } else {
      operands.push(arg);
    }
  }
  return operands;
}

function headTailOperands(args: string[]): string[] {
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) return [];
    if (arg === '--') return operands.concat(args.slice(index + 1));
    if (['-n', '--lines', '-c', '--bytes'].includes(arg)) {
      index += 1;
      if (!args[index] || !/^\d+$/.test(args[index] ?? '')) return [];
    } else if (/^-[nc]\d+$/.test(arg) || /^-\d+$/.test(arg)) {
      // Compact numeric option; it does not name a file.
    } else if (arg.startsWith('-')) {
      return [];
    } else {
      operands.push(arg);
    }
  }
  return operands;
}

function sedOperands(args: string[]): string[] {
  if (!args.includes('-n') || args.some((arg) => arg === '-i' || arg.startsWith('-i'))) return [];
  const filtered = args.filter((arg) => arg !== '-n');
  if (filtered.length < 2 || filtered[0]?.startsWith('-')) return [];
  // Only numeric-address print programs are proven read-only. Sed's broader
  // language includes `w` and `e`, which can mutate files or execute commands.
  if (!/^\d+(?:,\d+)?p$/.test(filtered[0] ?? '')) return [];
  return filtered.slice(1).every((arg) => !arg.startsWith('-')) ? filtered.slice(1) : [];
}

function ripgrepOperands(args: string[]): string[] {
  const safeFlags = new Set([
    '-n',
    '--line-number',
    '-H',
    '--with-filename',
    '-S',
    '--smart-case',
    '-i',
    '--ignore-case',
    '-s',
    '--case-sensitive',
    '-F',
    '--fixed-strings',
    '-w',
    '--word-regexp',
    '-x',
    '--line-regexp',
    '--hidden',
    '--no-ignore',
    '-l',
    '--files-with-matches',
    '-c',
    '--count',
  ]);
  let index = 0;
  while (index < args.length && args[index]?.startsWith('-')) {
    if (args[index] === '--') {
      index += 1;
      break;
    }
    if (!safeFlags.has(args[index] ?? '')) return [];
    index += 1;
  }
  const pattern = args[index];
  if (!pattern) return [];
  const paths = args.slice(index + 1);
  if (paths.length === 0 || paths.some((arg) => arg.startsWith('-') || arg === '.')) return [];
  return paths;
}

function stringInput(event: AgentToolUseEvent, key: string): string | undefined {
  const value = event.input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
