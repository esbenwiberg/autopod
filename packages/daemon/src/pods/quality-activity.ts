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

const WORKSPACE_ROOT = '/workspace';
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
  if (event.type === 'file_change') return normalizeFileChange(event);
  if (event.type !== 'tool_use') return [];

  const callId = stringInput(event, 'call_id') ?? stringInput(event, 'callId');
  const native = normalizeNativeTool(event, callId);
  if (native.length > 0 || event.tool !== 'Bash') return native;

  const command = stringInput(event, 'command');
  if (!command) return [];
  const cwd = stringInput(event, 'cwd') ?? WORKSPACE_ROOT;
  return inspectedShellPaths(command, cwd).map((path) => ({
    kind: 'inspection',
    path,
    source: 'shell-command',
    ...(callId && { callId }),
  }));
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

function inspectedShellPaths(command: string, cwd: string): string[] {
  const tokens = tokenizeShell(command);
  if (!tokens || tokens.length < 2) return [];
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
      operands = ripgrepOperands(args);
      break;
    default:
      return [];
  }

  if (operands.length === 0 || operands.some((operand) => operand === '-')) return [];
  const paths = operands.map((operand) => canonicalRepositoryPath(operand, cwd));
  return paths.every((path): path is string => path !== null) ? [...new Set(paths)] : [];
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
        if (quote === '"' && SHELL_META.has(character)) return null;
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
  if (args.length < 2) return [];
  const pattern = args[0];
  if (!pattern || pattern.startsWith('-')) return [];
  const paths = args.slice(1);
  if (paths.some((arg) => arg.startsWith('-') || arg === '.')) return [];
  return paths;
}

function stringInput(event: AgentToolUseEvent, key: string): string | undefined {
  const value = event.input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
