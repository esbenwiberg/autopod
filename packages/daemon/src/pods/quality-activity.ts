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
const INSPECTION_AFTER_CONTROL = /(?:^|&&|\|\||[;|])\s*(?:cat|head|tail|sed|rg|grep)(?:\s|$)/;
const BASH_LOGIN_INSPECTION =
  /^(?:\/bin\/)?bash\s+-lc\s+['"]?\s*(?:cat|head|tail|sed|rg|grep)(?:\s|$)/;
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
  const cwd = stringInput(event, 'cwd') ?? WORKSPACE_ROOT;
  const argvEvidence = structuredShellEvidence(event, cwd);
  const shellEvidence =
    argvEvidence ??
    (command ? inspectedShellEvidence(command, cwd) : { paths: [], ambiguous: false });
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
  const argv = stringArrayInput(event, 'argv');
  if (argv === null) return null;
  const [program, flag, script, ...rest] = argv;
  const isShell =
    program === 'bash' || program === '/bin/bash' || program === 'sh' || program === '/bin/sh';
  if (isShell && flag === '-lc' && typeof script === 'string' && rest.length === 0) {
    return inspectedShellEvidence(script, cwd);
  }
  return { paths: [], ambiguous: argv.some((argument) => looksLikeInspection(argument)) };
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

function inspectedShellEvidence(
  command: string,
  cwd: string,
): { paths: string[]; ambiguous: boolean } {
  const compound = splitReadOnlyCompound(command);
  if (compound !== null) {
    if (compound.length === 0) return { paths: [], ambiguous: looksLikeInspection(command) };
    const parts = compound.map((part) => inspectedShellEvidence(part, cwd));
    if (parts.some((part) => part.ambiguous || part.paths.length === 0)) {
      return { paths: [], ambiguous: looksLikeInspection(command) };
    }
    return {
      paths: [...new Set(parts.flatMap((part) => part.paths))],
      ambiguous: false,
    };
  }

  const tokens = tokenizeShell(command);
  if (!tokens) {
    return { paths: [], ambiguous: looksLikeInspection(command) };
  }

  const unwrapped = unwrapBashLoginCommand(tokens);
  if (unwrapped !== null) return inspectedShellEvidence(unwrapped, cwd);
  if (tokens.length < 2) {
    return { paths: [], ambiguous: looksLikeInspection(command) };
  }

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
      return { paths: [], ambiguous: looksLikeInspection(command) };
  }

  if (operands.length === 0 || operands.some((operand) => operand === '-')) {
    return { paths: [], ambiguous: looksLikeInspection(command) };
  }
  const paths = operands.map((operand) => canonicalRepositoryPath(operand, cwd));
  return paths.every((path): path is string => path !== null)
    ? { paths: [...new Set(paths)], ambiguous: false }
    : { paths: [], ambiguous: true };
}

function unwrapBashLoginCommand(tokens: string[]): string | null {
  const [program, flag, nested, ...rest] = tokens;
  if ((program !== '/bin/bash' && program !== 'bash') || flag !== '-lc') return null;
  if (!nested || rest.length > 0) return null;
  return nested;
}

function looksLikeInspection(command: string): boolean {
  return INSPECTION_AFTER_CONTROL.test(command) || BASH_LOGIN_INSPECTION.test(command);
}

/** Split only simple `&&`/`;` sequences; every segment must later prove read-only. */
function splitReadOnlyCompound(command: string): string[] | null {
  const segments: string[] = [];
  let segment = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let foundSeparator = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!character) return [];
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      segment += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (character === ';' || pair === '&&') {
      if (!segment.trim()) return [];
      segments.push(segment.trim());
      segment = '';
      foundSeparator = true;
      if (pair === '&&') index += 1;
      continue;
    }
    if ('|&<>`(){}\n\r'.includes(character) || character === '$') return [];
    segment += character;
  }

  if (!foundSeparator) return null;
  if (escaped || quote || !segment.trim()) return [];
  segments.push(segment.trim());
  return segments;
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
