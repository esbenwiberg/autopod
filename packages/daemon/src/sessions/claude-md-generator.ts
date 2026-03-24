import type { ActionDefinition, InjectedMcpServer, Profile, Session } from '@autopod/shared';
import type { ResolvedSection } from './section-resolver.js';

export interface ClaudeMdOptions {
  /** Resolved (already fetched) content sections to inject */
  injectedSections?: ResolvedSection[];
  /** MCP servers beyond the built-in escalation server */
  injectedMcpServers?: InjectedMcpServer[];
  /** Action definitions available to this session */
  availableActions?: ActionDefinition[];
}

export function generateClaudeMd(
  profile: Profile,
  session: Session,
  mcpServerUrl: string,
  options?: ClaudeMdOptions,
): string {
  const lines: string[] = [];

  lines.push('# Autopod Session');
  lines.push('');
  lines.push(`Session ID: ${session.id}`);
  lines.push(`Profile: ${session.profileName}`);
  lines.push(`Task: ${session.task}`);
  lines.push('');

  // Injected sections (sorted by priority — earlier = higher in document)
  const injectedSections = options?.injectedSections ?? [];
  for (const section of injectedSections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    lines.push(section.content);
    lines.push('');
  }

  // Operating Environment section (adapts to profile config)
  generateOperatingEnvironment(lines, profile, options?.availableActions ?? []);

  // MCP Servers section
  lines.push('## MCP Servers');
  lines.push('');
  lines.push('### Escalation & Monitoring');
  lines.push(`- URL: ${mcpServerUrl}`);
  lines.push('- Tools:');
  lines.push('  - ask_human — ask the human for input');
  lines.push('  - ask_ai — consult another AI');
  lines.push('  - report_blocker — report a blocking issue');
  lines.push('  - report_plan — declare your implementation plan (fire-and-forget)');
  lines.push('  - report_progress — report phase transitions (fire-and-forget)');
  lines.push('  - check_messages — poll for human nudge messages (non-blocking)');
  lines.push('');

  const injectedMcpServers = options?.injectedMcpServers ?? [];
  for (const server of injectedMcpServers) {
    lines.push(`### ${server.name}`);
    if (server.description) {
      lines.push(server.description);
    }
    lines.push(`- URL: ${server.url}`);
    if (server.toolHints) {
      for (const hint of server.toolHints) {
        lines.push(`- ${hint}`);
      }
    }
    lines.push('');
  }

  // Build & Run (adapts for artifact mode)
  if (profile.outputMode === 'artifact') {
    lines.push('## Output');
    lines.push('');
    lines.push('- Write your findings to `research-output.md` in the workspace root.');
    lines.push('- No build or validation will run — your output IS the deliverable.');
    lines.push('');
  } else {
    lines.push('## Build & Run');
    lines.push('');
    lines.push(`- Build: \`${profile.buildCommand}\``);
    lines.push(`- Start: \`${profile.startCommand}\``);
    lines.push(`- Health check: ${profile.healthPath}`);
    lines.push('');
  }

  if (profile.validationPages.length > 0) {
    lines.push('## Validation Pages');
    lines.push('');
    for (const page of profile.validationPages) {
      lines.push(`- ${page.path}`);
      if (page.assertions) {
        for (const a of page.assertions) {
          lines.push(`  - ${a.type}: ${a.selector}${a.value ? ` = "${a.value}"` : ''}`);
        }
      }
    }
    lines.push('');
  }

  if (profile.customInstructions) {
    lines.push('## Custom Instructions');
    lines.push('');
    lines.push(profile.customInstructions);
    lines.push('');
  }

  lines.push('## When to call ask_human');
  lines.push('');
  lines.push(
    'Call `ask_human` and **wait for a response** before proceeding whenever any of these apply:',
  );
  lines.push(
    '- The task is ambiguous or underspecified and assumptions could lead you in the wrong direction',
  );
  lines.push(
    '- You face a meaningful decision with multiple reasonable paths (architecture, approach, scope)',
  );
  lines.push('- You discover something unexpected that changes the nature or scope of the task');
  lines.push('- You are blocked and cannot make progress without more information');
  lines.push('- The task explicitly asks you to check in before acting');
  lines.push('');
  lines.push(
    '**Important**: Human responses come through the MCP tool — do NOT write questions as text output. ' +
      'The human cannot see your output stream; they only see what you send via `ask_human`.',
  );
  lines.push('');

  lines.push('## Workflow Requirements');
  lines.push('');
  lines.push(
    '1. **Plan first**: Before writing any code, call `report_plan` with your approach and numbered steps.',
  );
  lines.push(
    '2. **Report progress**: Break your work into 3-6 phases. Call `report_progress` at each transition.',
  );
  lines.push(
    '3. **Check for messages**: Call `check_messages` between phases to see if the human has guidance.',
  );
  lines.push(
    '4. **Phases are yours to define**: Name them whatever makes sense for the task. Common patterns:',
  );
  lines.push('   - Exploration → Implementation → Testing → Cleanup');
  lines.push('   - Analysis → Design → Build → Verify');
  lines.push('   - Investigation → Fix → Test → Document');
  lines.push('');

  lines.push('## Guidelines');
  lines.push('');
  if (profile.outputMode === 'artifact') {
    lines.push('- Focus on research quality and comprehensiveness');
    lines.push('- Structure your output clearly with headings and sections');
    lines.push('- Use ask_human when uncertain about scope or direction');
    lines.push('- Cite sources where applicable');
  } else {
    lines.push('- Make small, focused commits');
    lines.push('- Ensure the build passes before completing');
    lines.push('- Use ask_human when uncertain rather than guessing');
    lines.push('- Do NOT modify configuration files unless required by the task');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate the Operating Environment section.
 * Adapts based on profile configuration (network policy, actions, output mode).
 */
function generateOperatingEnvironment(
  lines: string[],
  profile: Profile,
  availableActions: ActionDefinition[],
): void {
  lines.push('## Operating Environment');
  lines.push('');
  lines.push('You are running inside an Autopod sandbox container with restricted access.');
  lines.push('');

  // Network section
  lines.push('### Network');
  if (profile.networkPolicy?.enabled) {
    if (profile.networkPolicy.allowedHosts.length > 0 && profile.networkPolicy.replaceDefaults) {
      // Research pod style — limited internet
      lines.push('- You have LIMITED internet access for research purposes.');
      lines.push(`- Allowed domains: ${profile.networkPolicy.allowedHosts.join(', ')}`);
      lines.push('- Blocked: cloud metadata endpoints, internal services.');
    } else {
      lines.push(
        '- Direct internet access is BLOCKED. Do not attempt curl/fetch/wget to external URLs.',
      );
      lines.push('- All external data access goes through the MCP action tools listed below.');
    }
  } else {
    lines.push('- Network policy is not enforced. You may have internet access.');
  }
  lines.push('');

  // Available Actions section
  if (availableActions.length > 0) {
    lines.push('### Available Actions');
    lines.push('These MCP tools let you access external context. All responses are PII-sanitized.');
    for (const action of availableActions) {
      const paramList = Object.entries(action.params)
        .map(([name, def]) => (def.required ? name : `${name}?`))
        .join(', ');
      lines.push(`- ${action.name}(${paramList}) — ${action.description}`);
    }
    lines.push('');
  }

  // What You Cannot Do
  lines.push('### What You Cannot Do');
  lines.push('- Access APIs directly (no tokens, no credentials)');
  lines.push('- Read files from repos other than your worktree (use read_file action instead)');
  lines.push('- See real email addresses or usernames (they are masked for privacy)');
  lines.push('');

  // Git Operations
  lines.push('### Git Operations');
  if (profile.outputMode === 'artifact') {
    lines.push('- You CAN use git within your worktree for version tracking.');
    lines.push('- Your primary output is the artifact file, not a PR.');
  } else {
    lines.push('- You CAN use git normally within your worktree (commit, branch, etc.)');
    lines.push('- Push and PR creation are handled by the system after your work completes.');
    lines.push('- Do NOT attempt to push or create PRs yourself.');
  }
  lines.push('');
}
