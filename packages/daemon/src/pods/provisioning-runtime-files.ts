import type { ExecutionTarget, StdioInjectedMcpServer } from '@autopod/shared';
import { CONTAINER_HOME_DIR } from '@autopod/shared';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import type { ContainerManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { shellQuote } from '../util/shell-quote.js';

/** Path to the agent shim script inside every pod container. */
export const AGENT_SHIM_PATH = '/run/autopod/agent-shim.sh';

export const AGENT_ENV_PATH = '/run/autopod/agent-env.sh';

/**
 * Shim script written to every pod container before the agent exec.
 * Reads *_FILE env vars and exports the real credential values so that SDKs
 * without native _FILE support still get the secret — but the raw value is
 * never present in the exec's initial environment visible to `docker inspect`
 * or a process-level env dump of the container's main entrypoint.
 */
// NOTE: this is a JS template literal. Bare `${...}` gets interpolated by JS at
// compile time, so every occurrence the shell needs to see literally must be
// escaped (`\${...}`). Likewise, when the shell needs to see a literal
// backslash before a `$`, the source needs `\\` (one for JS, one survives).
export const AGENT_SHIM_SCRIPT = `#!/bin/sh
# Autopod agent shim — expand *_FILE env vars before exec-ing the agent
if [ -f ${AGENT_ENV_PATH} ]; then
  . ${AGENT_ENV_PATH}
fi

# Persist the worker PID so daemon restart recovery can terminate the orphaned
# streaming process before resuming the durable CLI session in this sandbox.
# Provisioning creates this one user-owned control file. Failure means restart
# recovery cannot safely quiesce the worker, so do not hide it and start anyway.
pid_path="\${AUTOPOD_AGENT_PID_PATH:-/run/autopod/agent.pid}"
printf '%s\n' "$$" > "$pid_path" || {
  echo 'Autopod could not record the agent PID for restart recovery' >&2
  exit 1
}

_read_file_var() {
  local var_name="$1" file_var="\${1}_FILE"
  local path
  eval "path=\\\${$file_var:-}"
  [ -n "$path" ] && [ -f "$path" ] && export "$var_name=$(cat "$path")" && unset "$file_var"
}
_read_file_var ANTHROPIC_API_KEY
_read_file_var ANTHROPIC_FOUNDRY_API_KEY
_read_file_var ANTHROPIC_FOUNDRY_AUTH_TOKEN
_read_file_var OPENAI_API_KEY
_read_file_var CLAUDE_CODE_OAUTH_TOKEN
_read_file_var COPILOT_GITHUB_TOKEN
_read_file_var VSS_NUGET_EXTERNAL_FEED_ENDPOINTS
exec "$@"
`;

export const SANDBOX_AGENT_HOME_DIRS = ['.claude', '.autopod', '.codex', '.config'].map(
  (dir) => `${CONTAINER_HOME_DIR}/${dir}`,
);

export const SANDBOX_AGENT_HOME_FILES = [`${CONTAINER_HOME_DIR}/.claude.json`];

// Compact Python script that performs a real MCP JSON-RPC initialize handshake
// against a stdio MCP server. Called at pod startup to verify each code-intel
// server actually starts and responds — not just that the binary exists.
// Usage: python3 <script> <command> [arg...]
// Exit 0 = server responded with a valid result; Exit 1 = timeout or error.
export const MCP_INIT_PROBE_SCRIPT = `import subprocess,json,sys,select as sel
if len(sys.argv)<2:sys.exit(1)
cmd=sys.argv[1]
msg=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}})
frame=b"Content-Length: "+str(len(msg.encode())).encode()+b"\\r\\n\\r\\n"+msg.encode()
p=subprocess.Popen(sys.argv[1:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
  p.stdin.write(frame);p.stdin.flush()
  h=b""
  while b"\\r\\n\\r\\n" not in h:
    if not sel.select([p.stdout],[],[],50)[0]:print(f"timeout: {cmd} did not respond to initialize",file=sys.stderr);sys.exit(1)
    c=p.stdout.read(1)
    if not c:print(f"eof: {cmd} closed stdout",file=sys.stderr);sys.exit(1)
    h+=c
  n=int(h.split(b"Content-Length: ")[1].split(b"\\r\\n")[0])
  b=b""
  while len(b)<n:
    if not sel.select([p.stdout],[],[],50)[0]:print(f"timeout: {cmd} did not send body",file=sys.stderr);sys.exit(1)
    chunk=p.stdout.read(n-len(b))
    if not chunk:print(f"eof: {cmd} closed during body",file=sys.stderr);sys.exit(1)
    b+=chunk
  r=json.loads(b)
  sys.exit(0 if "result" in r else 1)
finally:
  p.terminate();p.wait()
`;

export function buildAgentEnvFile(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid agent env var name: ${key}`);
      }
      return `export ${key}=${shellQuote(value)}`;
    })
    .join('\n')}\n`;
}

export async function repairSandboxAgentHomeOwnership(
  containerManager: ContainerManager,
  containerId: string,
  executionTarget: ExecutionTarget,
): Promise<void> {
  if (executionTarget !== 'sandbox') return;

  const quotedDirs = SANDBOX_AGENT_HOME_DIRS.map(shellQuote).join(' ');
  const quotedFiles = SANDBOX_AGENT_HOME_FILES.map(shellQuote).join(' ');
  const script = [
    'set -eu',
    `mkdir -p ${quotedDirs}`,
    `chown -R autopod:autopod ${quotedDirs}`,
    `for f in ${quotedFiles}; do [ ! -e "$f" ] || chown autopod:autopod "$f"; done`,
  ].join(' && ');

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(containerId, ['sh', '-c', script], {
      timeout: 10_000,
      user: 'root',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof SandboxInfrastructureError) {
      err.message = `Sandbox startup could not repair agent home ownership: ${detail}`;
      throw err;
    }
    throw new Error(`Sandbox startup could not repair agent home ownership: ${detail}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox startup could not repair agent home ownership (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
  }
}

/**
 * Translate profile.codeIntelligence flags into StdioInjectedMcpServer entries.
 * These are written directly to /workspace/.mcp.json — they bypass the daemon proxy
 * because they are local subprocesses inside the container, not remote HTTP servers.
 */
export function buildCodeIntelligenceServers(
  profile: PodExecutionSettings,
): StdioInjectedMcpServer[] {
  const servers: StdioInjectedMcpServer[] = [];
  if (profile.codeIntelligence?.serena) {
    // Upstream contract: `serena start-mcp-server --context=claude-code --project=<dir>`.
    // The bare `--project /workspace` form (the previous version) silently failed
    // because it skips the `start-mcp-server` subcommand entirely.
    servers.push({
      type: 'stdio',
      name: 'serena',
      command: 'serena',
      args: ['start-mcp-server', '--context=claude-code', '--project=/workspace'],
      description:
        'LSP-backed semantic code navigation. Provides go-to-definition, find-references, ' +
        'type hierarchy, and barrel-export resolution for TypeScript (tsserver) and C# (Roslyn).',
      toolHints: [
        'ALWAYS use instead of grep for symbol navigation — tsserver resolves path aliases and declaration merging that grep misses',
        'Finding a symbol definition or all callers: use find_symbol / find_referencing_symbols — NOT grep',
        'Resolving a barrel export or path-aliased import: use symbol_overview — NOT file reads',
        'Understanding a class hierarchy: use type_hierarchy — NOT manual directory traversal',
      ],
      toolNames: [
        'mcp__serena__find_symbol',
        'mcp__serena__find_referencing_symbols',
        'mcp__serena__find_implementations',
        'mcp__serena__symbol_overview',
        'mcp__serena__type_hierarchy',
        'mcp__serena__search_for_pattern',
      ],
    });
  }
  if (profile.codeIntelligence?.roslynCodeLens) {
    servers.push({
      type: 'stdio',
      name: 'roslyn-codelens',
      command: 'roslyn-codelens-mcp',
      description:
        'Roslyn-backed C# DI analysis. Use get_di_registrations to trace which concrete type ' +
        'the DI container injects for an interface, and find_implementations for interface resolution.',
      toolHints: [
        'ALWAYS call get_di_registrations before reading service registration files — do NOT trace registrations manually',
        'Resolving interface → concrete type: use find_implementations — NOT grep for class names',
        'Finding all callers of a method: use find_callers — NOT grep',
        'Navigating to a definition: use go_to_definition — NOT file reads',
      ],
      toolNames: [
        'mcp__roslyn-codelens__get_di_registrations',
        'mcp__roslyn-codelens__find_implementations',
        'mcp__roslyn-codelens__find_references',
        'mcp__roslyn-codelens__find_callers',
        'mcp__roslyn-codelens__go_to_definition',
        'mcp__roslyn-codelens__get_type_hierarchy',
      ],
    });
  }
  return servers;
}
