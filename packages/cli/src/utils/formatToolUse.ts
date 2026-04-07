import type { AgentToolUseEvent } from '@autopod/shared';
import { truncate } from './truncate.js';

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * Produce a human-readable one-line summary of a tool_use event.
 * Extracts the most meaningful field per tool type instead of dumping param names.
 */
export function formatToolUse(
  tool: string,
  input: Record<string, unknown>,
  maxLength = 80,
): string {
  const t = tool.toLowerCase();
  let summary: string;

  switch (t) {
    case 'bash': {
      const desc = str(input.description);
      const cmd = str(input.command);
      summary = desc || (cmd ? `$ ${cmd}` : 'Bash');
      break;
    }
    case 'read': {
      const fp = str(input.file_path);
      const name = fp ? basename(fp) : '';
      const offset = input.offset != null ? Number(input.offset) : null;
      const limit = input.limit != null ? Number(input.limit) : null;
      const range =
        offset != null && limit != null
          ? ` L${offset}-${offset + limit}`
          : offset != null
            ? ` L${offset}+`
            : '';
      summary = name ? `Read ${name}${range}` : 'Read';
      break;
    }
    case 'edit':
    case 'multiedit': {
      const fp = str(input.file_path);
      summary = fp ? `Edit ${basename(fp)}` : 'Edit';
      break;
    }
    case 'write': {
      const fp = str(input.file_path);
      summary = fp ? `Write ${basename(fp)}` : 'Write';
      break;
    }
    case 'grep': {
      const pattern = str(input.pattern);
      const path = str(input.path);
      const inPart = path ? ` in ${basename(path)}` : '';
      summary = pattern ? `Grep /${pattern}/${inPart}` : 'Grep';
      break;
    }
    case 'glob': {
      const pattern = str(input.pattern);
      summary = pattern ? `Glob ${pattern}` : 'Glob';
      break;
    }
    case 'agent': {
      const desc = str(input.description);
      summary = desc || 'Agent sub-task';
      break;
    }
    case 'websearch': {
      const query = str(input.query);
      summary = query ? `Search: ${query}` : 'WebSearch';
      break;
    }
    case 'webfetch': {
      const url = str(input.url);
      summary = url ? `Fetch: ${url}` : 'WebFetch';
      break;
    }
    default: {
      // Fall back to first string-valued input field
      const firstVal = Object.values(input).find((v) => typeof v === 'string' && v.length > 0);
      summary = firstVal ? `${tool} ${str(firstVal)}` : tool;
      break;
    }
  }

  // Strip newlines and truncate
  return truncate(summary.replace(/[\n\r]+/g, ' '), maxLength);
}

/**
 * Returns a stable key identifying the "same action" for repetition detection.
 * Two events with the same key in sequence indicate the agent is repeating itself.
 */
export function getToolUseKey(event: AgentToolUseEvent): string {
  const t = event.tool.toLowerCase();
  switch (t) {
    case 'bash':
      return `bash:${str(event.input.command)}`;
    case 'read':
      return `read:${str(event.input.file_path)}`;
    case 'edit':
    case 'multiedit':
      return `edit:${str(event.input.file_path)}`;
    case 'write':
      return `write:${str(event.input.file_path)}`;
    case 'grep':
      return `grep:${str(event.input.pattern)}`;
    case 'glob':
      return `glob:${str(event.input.pattern)}`;
    default:
      return `${t}:${str(Object.values(event.input)[0])}`;
  }
}
