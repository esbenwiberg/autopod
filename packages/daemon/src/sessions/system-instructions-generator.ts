import type {
  ActionDefinition,
  InjectedMcpServer,
  InjectedSkill,
  Profile,
  Session,
} from '@autopod/shared';
import type { ResolvedSection } from './section-resolver.js';

export interface SystemInstructionsOptions {
  /** Resolved (already fetched) content sections to inject */
  injectedSections?: ResolvedSection[];
  /** MCP servers beyond the built-in escalation server */
  injectedMcpServers?: InjectedMcpServer[];
  /** Action definitions available to this session */
  availableActions?: ActionDefinition[];
  /** Skills (slash commands) injected into this session */
  injectedSkills?: InjectedSkill[];
}

export function generateSystemInstructions(
  profile: Profile,
  session: Session,
  mcpServerUrl: string,
  options?: SystemInstructionsOptions,
): string {
  const lines: string[] = [];

  lines.push('# Autopod Session');
  lines.push('');
  lines.push(`Session ID: ${session.id}`);
  lines.push(`Profile: ${session.profileName}`);
  lines.push('');
  // Wrap the user-supplied task in explicit boundary markers so the LLM can distinguish
  // it from system instructions. This is a prompt-injection mitigation: even if the task
  // text contains adversarial instructions they are clearly scoped as user-provided data.
  lines.push('## Task');
  lines.push('');
  lines.push('<!-- BEGIN USER TASK -->');
  lines.push(session.task);
  lines.push('<!-- END USER TASK -->');
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
  lines.push(
    'MCP tools are available as native tool calls — invoke them directly. ' +
      'Do NOT attempt to call MCP endpoints via curl, fetch, or HTTP requests. ' +
      'Claude handles MCP transport automatically.',
  );
  lines.push('');
  lines.push('### Escalation & Monitoring');
  lines.push(`- URL: ${mcpServerUrl}`);
  lines.push('- Tools:');
  lines.push('  - ask_human — ask the human for input');
  lines.push('  - ask_ai — consult another AI');
  lines.push('  - report_blocker — report a blocking issue');
  lines.push('  - report_plan — declare your implementation plan (fire-and-forget)');
  lines.push('  - report_progress — report phase transitions (fire-and-forget)');
  lines.push(
    '  - report_task_summary — report what you actually did and any deviations from your plan (call as your final step)',
  );
  lines.push('  - check_messages — poll for human nudge messages (non-blocking)');
  lines.push('  - validate_in_browser — open a browser to verify your work (localhost URLs only)');
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

  // Injected Skills (slash commands)
  const injectedSkills = options?.injectedSkills ?? [];
  if (injectedSkills.length > 0) {
    lines.push('## Available Skills');
    lines.push('');
    lines.push('The following custom slash commands are available in this session:');
    lines.push('');
    for (const skill of injectedSkills) {
      const desc = skill.description ? ` — ${skill.description}` : '';
      lines.push(`- \`/${skill.name}\`${desc}`);
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
    if (profile.testCommand) {
      lines.push(`- Test: \`${profile.testCommand}\``);
    }
    lines.push(`- Start: \`${profile.startCommand}\``);
    lines.push(`- Health check: ${profile.healthPath}`);
    lines.push(
      '- **Port**: Your app must listen on `$PORT` (currently 3000). ' +
        'Do NOT use port 3100 — that is the host daemon. ' +
        'If you curl localhost:3100 you are hitting the control plane, not your app.',
    );
    lines.push('');
  }

  if (profile.smokePages.length > 0) {
    lines.push('## Smoke Pages');
    lines.push('');
    for (const page of profile.smokePages) {
      lines.push(`- ${page.path}`);
      if (page.assertions) {
        for (const a of page.assertions) {
          lines.push(`  - ${a.type}: ${a.selector}${a.value ? ` = "${a.value}"` : ''}`);
        }
      }
    }
    lines.push('');
  }

  if (session.acceptanceCriteria && session.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    lines.push(
      'Your changes must satisfy these criteria. The system will independently verify each one in a browser after you commit:',
    );
    lines.push('');
    // Acceptance criteria are user-supplied — wrap in boundary markers.
    lines.push('<!-- BEGIN USER ACCEPTANCE CRITERIA -->');
    for (const ac of session.acceptanceCriteria) {
      lines.push(`- ${ac}`);
    }
    lines.push('<!-- END USER ACCEPTANCE CRITERIA -->');
    lines.push('');

    lines.push('### Self-Validation');
    lines.push('');
    lines.push(
      'Before committing, use the `validate_in_browser` tool to verify your work against the acceptance criteria above. ' +
        'This opens a real browser in your container. Pass the localhost URL of your running app and natural language checks describing what to verify.',
    );
    lines.push('');
    lines.push('Example:');
    lines.push('```');
    lines.push('validate_in_browser({');
    lines.push('  url: "http://localhost:3000/settings",');
    lines.push('  checks: [');
    lines.push('    "Verify there is a dark mode toggle that is visible and clickable",');
    lines.push('    "Verify the page title contains Settings"');
    lines.push('  ]');
    lines.push('})');
    lines.push('```');
    lines.push('');
    lines.push(
      'Your self-validation results are NOT shared with the independent reviewer — ' +
        'they exist to help you catch issues early, like a developer testing before pushing.',
    );
    lines.push('');
  }

  if (profile.customInstructions) {
    lines.push('## Custom Instructions');
    lines.push('');
    // Custom instructions are profile-admin-supplied — wrap in boundary markers.
    lines.push('<!-- BEGIN CUSTOM INSTRUCTIONS -->');
    lines.push(profile.customInstructions);
    lines.push('<!-- END CUSTOM INSTRUCTIONS -->');
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
  lines.push(
    '- You are about to install or add a **new dependency** ' +
      '(npm install, pip install, dotnet add package, cargo add, etc.) — ' +
      'call `ask_human` first, describe the package and why it is needed, and wait for approval. ' +
      'Do not proceed with the install until approved.',
  );
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
    '3. **Commit regularly**: After each phase (or sooner for significant changes), run ' +
      '`git add -A && git commit -m "..."`. Do not save all commits for the end.',
  );
  lines.push(
    '4. **Check for messages**: Call `check_messages` between phases to see if the human has guidance.',
  );
  lines.push(
    '5. **Summarise before finishing**: As your very last step, call `report_task_summary` with:',
  );
  lines.push('   - `actualSummary`: a concise description of what was actually accomplished');
  lines.push(
    '   - `deviations`: an array of any steps where you deviated from your original plan. ' +
      'For each deviation include the step name, what was planned, what you did instead, and why. ' +
      'Use an empty array if you followed the plan exactly.',
  );
  lines.push(
    '   Transparency is rewarded — the independent reviewer will see your deviations and assess ' +
      'whether they were justified. A well-reasoned deviation is better than silently skipping a step.',
  );
  lines.push(
    '6. **Phases are yours to define**: Name them whatever makes sense for the task. Common patterns:',
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
    lines.push('- Commit after every meaningful unit of work — do not batch everything at the end');
    lines.push('- Ensure the build passes before completing');
    lines.push('- Use ask_human when uncertain rather than guessing');
    lines.push('- Do NOT modify configuration files unless required by the task');
  }
  lines.push('');

  lines.push('## Troubleshooting');
  lines.push('');
  lines.push(
    '- **Native module errors** (e.g. `better-sqlite3`, `sharp`, `bcrypt`): ' +
      'Re-run the build command once. If native binding errors persist after one retry, ' +
      'call `report_blocker` immediately — this is an infrastructure issue you CANNOT fix. ' +
      'Do NOT run node-gyp directly, install Node headers, modify .npmrc, or change compiler flags.',
  );
  lines.push(
    '- **MCP tool failures**: If an MCP tool call fails, check your input format. ' +
      'Do not try to replicate MCP calls via curl/HTTP. ' +
      'Report persistent failures via `report_blocker`.',
  );
  lines.push(
    '- **Validation is automatic**: After you commit and finish, the system independently runs ' +
      'build, tests, health checks, smoke tests, and AC validation. ' +
      'You do not need to replicate this pipeline. Use `validate_in_browser` for quick self-checks only.',
  );
  lines.push(
    '- **Do not retry identical failing commands more than twice.** ' +
      'Diagnose the root cause or try a different approach.',
  );
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
    lines.push(
      'These MCP tools let you access external context. All responses are PII-sanitized. ' +
        '**You MUST use these tools** for all external data access — do NOT use `gh`, `curl`, ' +
        '`wget`, or any CLI/HTTP client to access GitHub, Azure DevOps, or other external APIs. ' +
        'The action tools handle authentication, rate limiting, PII redaction, and audit logging.',
    );
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
  if (availableActions.length > 0) {
    lines.push(
      '- Do NOT use `gh`, `hub`, `curl`, `wget`, or direct HTTP requests to access external APIs.',
    );
    lines.push(
      '  Use the Available Actions listed above instead — they are the ONLY sanctioned way to ' +
        'access external data.',
    );
  }
  lines.push('- Access APIs directly (no tokens, no credentials are available in the container)');
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
    lines.push('- **Commit frequently** — after each meaningful unit of work (e.g. a passing');
    lines.push(
      '  test, a completed function, a working feature slice). This preserves your progress',
    );
    lines.push('  in case of interruptions.');
    lines.push('- Do NOT run `git push` — the system pushes and creates PRs on your behalf');
  }
  lines.push('');
}
