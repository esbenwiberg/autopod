import type { Profile, Session } from '@autopod/shared';

export function generateClaudeMd(profile: Profile, session: Session, mcpServerUrl: string): string {
  const lines: string[] = [];

  lines.push('# Autopod Session');
  lines.push('');
  lines.push(`Session ID: ${session.id}`);
  lines.push(`Profile: ${session.profileName}`);
  lines.push(`Task: ${session.task}`);
  lines.push('');

  lines.push('## MCP Server');
  lines.push('');
  lines.push('An escalation MCP server is available for when you need help:');
  lines.push(`- URL: ${mcpServerUrl}`);
  lines.push('- Tools: ask_human (ask the human for input), ask_ai (consult another AI), report_blocker (report a blocking issue)');
  lines.push('');

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
