import type { PodsitterRuntime, ReasoningEffort } from '@autopod/shared';

const PROMPT_PATH = '/run/autopod/decision-prompt';
const EMPTY_MCP_PATH = '/run/autopod/empty-mcp.json';
export const SYSTEM_CREDENTIAL_SHIM_PATH = '/run/autopod/system-credential-shim.sh';
export const SYSTEM_CREDENTIAL_SHIM = `#!/bin/sh
set -eu
read_secret() {
  local var_name="$1" file_var="\${1}_FILE"
  local file_path
  eval "file_path=\\\${$file_var:-}"
  if [ -n "$file_path" ]; then
    [ -f "$file_path" ] || exit 126
    export "$var_name=$(cat "$file_path")"
    unset "$file_var"
  fi
}
read_secret ANTHROPIC_API_KEY
read_secret OPENAI_API_KEY
read_secret CLAUDE_CODE_OAUTH_TOKEN
read_secret COPILOT_GITHUB_TOKEN
exec "$@"
`;

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
          `${SYSTEM_CREDENTIAL_SHIM_PATH} claude -p --output-format json --model "$1" --strict-mcp-config --mcp-config "$2" --tools "" < "$3"`,
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
          `${SYSTEM_CREDENTIAL_SHIM_PATH} codex exec --json --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --disable shell_tool --disable unified_exec --disable web_search_request --disable image_generation --disable browser_use --disable computer_use --disable apps --disable enable_mcp_apps --disable multi_agent --disable plugins --model "$1"${
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
          `${SYSTEM_CREDENTIAL_SHIM_PATH} copilot -p "$(cat "$2")" --model "$1" --available-tools= --disable-builtin-mcps --no-custom-instructions --no-remote --no-remote-export --no-ask-user --no-auto-update --output-format json --no-color`,
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
