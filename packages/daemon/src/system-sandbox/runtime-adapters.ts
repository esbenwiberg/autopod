import type { PodsitterRuntime, ReasoningEffort } from '@autopod/shared';

const PROMPT_PATH = '/run/autopod/decision-prompt';
const EMPTY_MCP_PATH = '/run/autopod/empty-mcp.json';

export interface SystemRuntimeInvocation {
  command: string[];
  promptPath: string;
  controlFiles: Array<{ path: string; content: string }>;
}

export function buildSystemRuntimeInvocation(input: {
  runtime: PodsitterRuntime;
  model: string;
  reasoningEffort?: ReasoningEffort;
}): SystemRuntimeInvocation {
  const controlFiles = [{ path: EMPTY_MCP_PATH, content: '{"mcpServers":{}}' }];
  switch (input.runtime) {
    case 'claude':
      return {
        promptPath: PROMPT_PATH,
        controlFiles,
        command: [
          'sh',
          '-c',
          `claude -p --output-format json --model "$1" --strict-mcp-config --mcp-config "$2" --tools "" < "$3"`,
          'system-decision',
          input.model,
          EMPTY_MCP_PATH,
          PROMPT_PATH,
        ],
      };
    case 'codex':
      return {
        promptPath: PROMPT_PATH,
        controlFiles,
        command: [
          'sh',
          '-c',
          `codex exec --json --sandbox read-only --skip-git-repo-check --model "$1"${
            input.reasoningEffort ? ` -c model_reasoning_effort="${input.reasoningEffort}"` : ''
          } - < "$2"`,
          'system-decision',
          input.model,
          PROMPT_PATH,
        ],
      };
    case 'copilot':
      return {
        promptPath: PROMPT_PATH,
        controlFiles,
        command: [
          'sh',
          '-c',
          'copilot -p "$(cat "$2")" --model "$1" --allow-all-tools=false --no-color',
          'system-decision',
          input.model,
          PROMPT_PATH,
        ],
      };
    case 'pi':
      return {
        promptPath: PROMPT_PATH,
        controlFiles,
        command: [
          'sh',
          '-c',
          'pi --print --mode json --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --model "$1" < "$2"',
          'system-decision',
          input.model,
          PROMPT_PATH,
        ],
      };
  }
}
