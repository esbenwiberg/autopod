import type { Profile, Session, InjectedMcpServer } from '@autopod/shared';
import type { ResolvedSection } from './section-resolver.js';

export interface ClaudeMdOptions {
  /** Resolved (already fetched) content sections to inject */
  injectedSections?: ResolvedSection[];
  /** MCP servers beyond the built-in escalation server */
  injectedMcpServers?: InjectedMcpServer[];
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

  // MCP Servers section
  lines.push('## MCP Servers');
  lines.push('');
  lines.push('### Escalation (ask for help)');
  lines.push(`- URL: ${mcpServerUrl}`);
  lines.push('- Tools: ask_human (ask the human for input), ask_ai (consult another AI), report_blocker (report a blocking issue)');
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

  lines.push('## Build & Run');
  lines.push('');
  lines.push(`- Build: \`${profile.buildCommand}\``);
  lines.push(`- Start: \`${profile.startCommand}\``);
  lines.push(`- Health check: ${profile.healthPath}`);
  lines.push('');

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

  lines.push('## Guidelines');
  lines.push('');
  lines.push('- Make small, focused commits');
  lines.push('- Ensure the build passes before completing');
  lines.push('- Use the escalation tools when blocked or uncertain');
  lines.push('- Do NOT modify configuration files unless required by the task');
  lines.push('');

  return lines.join('\n');
}
