import type {
  ActionDefinition,
  InjectedMcpServer,
  InjectedSkill,
  MemoryEntry,
  Pod,
  Profile,
} from '@autopod/shared';
import { MAX_MEMORY_INDEX_ENTRIES } from '@autopod/shared';
import type { ResolvedSection } from './section-resolver.js';

export interface SystemInstructionsOptions {
  /** Resolved (already fetched) content sections to inject */
  injectedSections?: ResolvedSection[];
  /** MCP servers beyond the built-in escalation server */
  injectedMcpServers?: InjectedMcpServer[];
  /** Action definitions available to this pod */
  availableActions?: ActionDefinition[];
  /** Skills (slash commands) injected into this pod */
  injectedSkills?: InjectedSkill[];
  /** Approved memory entries (global + profile + pod) */
  memories?: MemoryEntry[];
}

export function generateSystemInstructions(
  profile: Profile,
  pod: Pod,
  mcpServerUrl: string,
  options?: SystemInstructionsOptions,
): string {
  const lines: string[] = [];

  lines.push('# Autopod Pod');
  lines.push('');
  lines.push(`Pod ID: ${pod.id}`);
  lines.push(`Profile: ${pod.profileName}`);
  lines.push('');

  // Series-level shared docs come BEFORE the per-brief task so the agent reads
  // "why" + "how it fits" first, then the specific brief. Boundary markers
  // scope the user-authored prose against prompt injection in the same way as
  // the task block.
  if (pod.seriesDescription) {
    lines.push('## Purpose');
    lines.push('');
    lines.push(
      'This pod belongs to a planned spec. Read this purpose every time you make a judgment call.',
    );
    lines.push('');
    lines.push('<!-- BEGIN SPEC PURPOSE -->');
    lines.push(pod.seriesDescription);
    lines.push('<!-- END SPEC PURPOSE -->');
    lines.push('');
  }

  if (pod.seriesDesign) {
    lines.push('## Design');
    lines.push('');
    lines.push(
      'Cross-pod contracts, seams, and reference reading for this spec. Honor the contracts; deviations are reviewer-flagged.',
    );
    lines.push('');
    lines.push('<!-- BEGIN SPEC DESIGN -->');
    lines.push(pod.seriesDesign);
    lines.push('<!-- END SPEC DESIGN -->');
    lines.push('');
  }

  // Wrap the user-supplied task in explicit boundary markers so the LLM can distinguish
  // it from system instructions. This is a prompt-injection mitigation: even if the task
  // text contains adversarial instructions they are clearly scoped as user-provided data.
  lines.push('## Brief');
  lines.push('');
  lines.push('<!-- BEGIN USER TASK -->');
  lines.push(pod.task);
  lines.push('<!-- END USER TASK -->');
  lines.push('');

  // Advisory scope hints from the brief frontmatter. The reviewer sees the
  // same lists and treats deviations as discussion items, not failures —
  // explicit here so the agent knows what it was authorized for and where
  // to justify a deviation if it makes one.
  if (
    (pod.touches && pod.touches.length > 0) ||
    (pod.doesNotTouch && pod.doesNotTouch.length > 0)
  ) {
    lines.push('## Files in scope (advisory)');
    lines.push('');
    lines.push(
      'These lists are guidance, not enforcement. You may deviate when the work clearly requires it — when you do, explain the deviation in your commit message so the reviewer can adjudicate.',
    );
    lines.push('');
    if (pod.touches && pod.touches.length > 0) {
      lines.push('**Files this brief expects to modify:**');
      for (const path of pod.touches) {
        lines.push(`- ${path}`);
      }
      lines.push('');
    }
    if (pod.doesNotTouch && pod.doesNotTouch.length > 0) {
      lines.push("**Files outside this brief's scope (avoid unless necessary):**");
      for (const path of pod.doesNotTouch) {
        lines.push(`- ${path}`);
      }
      lines.push('');
    }
  }

  // Injected sections (sorted by priority — earlier = higher in document)
  const injectedSections = options?.injectedSections ?? [];
  for (const section of injectedSections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    lines.push(section.content);
    lines.push('');
  }

  // PIM groups available for this pod
  if (pod.pimGroups?.length) {
    lines.push('## Azure PIM Groups');
    lines.push('');
    lines.push(
      'The following PIM groups are pre-approved for this pod. ' +
        'Use `activate_pim_group` only when you specifically need the access described ' +
        '— not as a workaround for unrelated issues:',
    );
    lines.push('');
    for (const group of pod.pimGroups) {
      const name = group.displayName ?? group.groupId;
      const desc = group.justification ? ` — ${group.justification}` : '';
      lines.push(`- \`${group.groupId}\` (${name})${desc}`);
    }
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
  lines.push('  - memory_list — list approved memories for global/profile/pod scope');
  lines.push('  - memory_read — retrieve full content of a memory entry by ID');
  lines.push('  - memory_search — search memories by keyword');
  lines.push(
    '  - memory_suggest — suggest a new memory for human approval ' +
      '(use to capture conventions, patterns, or reusable knowledge discovered during the pod)',
  );

  // Action tools live on the same MCP server — list them in the same bullet list
  // so the agent includes them in its initial ToolSearch select: call.
  const availableActions = options?.availableActions ?? [];
  for (const action of availableActions) {
    lines.push(`  - ${action.name} — ${action.description}`);
  }

  const injectedMcpServers = options?.injectedMcpServers ?? [];
  for (const server of injectedMcpServers) {
    lines.push(`### ${server.name}`);
    if (server.description) {
      lines.push(server.description);
    }
    if (server.type === 'stdio') {
      lines.push(`- Transport: stdio (local subprocess — \`${server.command}\`)`);
    } else {
      lines.push(`- URL: ${server.url}`);
    }
    if (server.toolHints) {
      for (const hint of server.toolHints) {
        lines.push(`- ${hint}`);
      }
    }
    lines.push('');
  }

  // Advisor mode — instruct the agent to proactively consult ask_ai
  if (profile.escalation?.advisor.enabled) {
    lines.push('## AI Advisor');
    lines.push('');
    lines.push(
      'An AI advisor is available via the `ask_ai` tool. Use it **proactively** — ' +
        'do not wait until you are stuck:',
    );
    lines.push('');
    lines.push('1. **Before writing complex logic** — describe your approach and ask for a review');
    lines.push(
      '2. **When stuck or hitting repeated errors** — share the error and what you have tried',
    );
    lines.push('3. **Before completing the task** — ask for a final review of your changes');
    lines.push('');
    lines.push(
      'Always include relevant code context in the `context` parameter. ' +
        'Use the `domain` parameter when asking about a specific area (e.g. "security", "performance").',
    );
    lines.push('');
  }

  // Injected Skills (slash commands)
  const injectedSkills = options?.injectedSkills ?? [];
  if (injectedSkills.length > 0) {
    lines.push('## Available Skills');
    lines.push('');
    lines.push('The following custom slash commands are available in this pod:');
    lines.push('');
    for (const skill of injectedSkills) {
      const desc = skill.description ? ` — ${skill.description}` : '';
      lines.push(`- \`/${skill.name}\`${desc}`);
    }
    lines.push('');
  }

  // Reference repos (artifact mode only)
  if (pod.referenceRepos?.length) {
    lines.push('## Reference Repositories');
    lines.push('The following repos are cloned read-only at:');
    for (const repo of pod.referenceRepos) {
      lines.push(`- \`/repos/${repo.mountPath}/\` — ${repo.url}`);
    }
    lines.push('Do not attempt to push to these repos. They are read-only clones.');
    lines.push('');
  }

  // Build & Run (adapts for artifact mode)
  if (profile.outputMode === 'artifact') {
    lines.push('## Output');
    lines.push('');
    lines.push('- Write your findings to `research-output.md` in the workspace root.');
    lines.push('- No build or validation will run — your output IS the deliverable.');
    lines.push(
      '- Web search and browsing are available via built-in Claude tools. Write all output files to `/workspace/` — they will be collected as artifacts on completion.',
    );
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

  if (pod.acceptanceCriteria && pod.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    const hasWebUi = profile.hasWebUi ?? true;
    if (hasWebUi) {
      lines.push(
        'Your changes must satisfy these criteria. The system will independently verify each one after you commit — criteria are checked via browser, HTTP request, or code review depending on their type:',
      );
    } else {
      lines.push(
        'Your changes must satisfy these criteria. The system will independently verify each one after you commit via API probing and diff review:',
      );
    }
    lines.push('');
    // Acceptance criteria are user-supplied — wrap in boundary markers.
    lines.push('<!-- BEGIN USER ACCEPTANCE CRITERIA -->');
    for (const ac of pod.acceptanceCriteria) {
      const typeLabel = ac.type === 'web' ? 'browser' : ac.type === 'api' ? 'API' : 'code';
      lines.push(`- [${typeLabel}] ${ac.test}`);
      lines.push(`  - Pass: ${ac.pass}`);
      lines.push(`  - Fail: ${ac.fail}`);
    }
    lines.push('<!-- END USER ACCEPTANCE CRITERIA -->');
    lines.push('');

    if (hasWebUi) {
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
  }

  if (pod.seriesId) {
    lines.push('## Series Handover Protocol');
    lines.push('');
    lines.push(
      `This pod is part of series **${pod.seriesName ?? pod.seriesId}**. The next pod in the series will stack its branch on top of yours and read your handover file.`,
    );
    lines.push('');

    // Read every parent's handover, not "the most recent file" — when a brief
    // depends on multiple parents (fan-in) the previous behaviour was ambiguous.
    const parentIds = pod.dependsOnPodIds?.length
      ? pod.dependsOnPodIds
      : pod.dependsOnPodId
        ? [pod.dependsOnPodId]
        : [];
    if (parentIds.length === 1) {
      const [parentId] = parentIds;
      lines.push(
        `Before starting, read the handover file from your parent pod: \`specs/${pod.seriesId}/handovers/${parentId}.md\`.`,
      );
      lines.push('');
    } else if (parentIds.length > 1) {
      lines.push(
        'Before starting, read the handover file from EACH of your parent pods (one per dependency):',
      );
      for (const parentId of parentIds) {
        lines.push(`- \`specs/${pod.seriesId}/handovers/${parentId}.md\``);
      }
      lines.push('');
    }

    lines.push(
      `Before finishing, write a handover summary to \`specs/${pod.seriesId}/handovers/${pod.id}.md\` and commit it. Include:`,
    );
    lines.push('- What you built and any deviations from the brief');
    lines.push('- Interfaces or contracts you changed that downstream pods must know about');
    lines.push('- Files you own that the next pod should NOT modify without good reason');
    lines.push('- Any discovered constraints or landmines');
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

  if (options?.memories?.length) {
    // Inject a lightweight index instead of full content to avoid context bloat.
    // Agents use `memory_read` to pull full content for entries relevant to their task.
    const sorted = sortMemoriesForIndex(options.memories);
    const shown = sorted.slice(0, MAX_MEMORY_INDEX_ENTRIES);
    const omitted = sorted.length - shown.length;

    lines.push('## Available Memory');
    lines.push('');
    lines.push(
      'The following knowledge entries are available. ' +
        'Review the list and use `memory_read` with the entry ID to retrieve full content for entries relevant to your task. ' +
        'Use `memory_search` to find entries by keyword. ' +
        'To suggest new memories use `memory_suggest` — a human will review before it becomes active.',
    );
    lines.push('');
    for (const m of shown) {
      lines.push(`- ${m.path} (${m.scope}, id: ${m.id})`);
    }
    if (omitted > 0) {
      lines.push('');
      lines.push(`(${omitted} more available — use \`memory_search\` to find others)`);
    }
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
    '5. **Capture knowledge for future agents**: Before finishing, call `memory_suggest` ' +
      'if — and only if — you learned something worth preserving. ' +
      "Skip it if you didn't. **Filler is worse than nothing** — an approval queue full of trivia gets ignored.",
  );
  lines.push('');
  lines.push('   **Strong candidates** (suggest these):');
  lines.push(
    '   - Gotchas that fail silently or surprise you (API quirks, env assumptions, race conditions)',
  );
  lines.push(
    "   - Integration details that aren't obvious from reading the code (auth flows, required headers, ordering constraints)",
  );
  lines.push('   - Decision rationale — *why* a pattern exists, not just that it does');
  lines.push(
    "   - Debugging lessons — what looked broken but wasn't, or what looked fine but hid a bug",
  );
  lines.push(
    '   - Workflow tricks that saved time (or the failed path you tried first, so the next agent skips it)',
  );
  lines.push(
    '   - Cross-cutting patterns specific to this codebase (error handling, retries, logging conventions)',
  );
  lines.push('');
  lines.push('   **Weak candidates** (skip these):');
  lines.push('   - Restating what `CLAUDE.md` already says');
  lines.push('   - Generic best practices any competent agent already knows');
  lines.push('   - What command you ran — only the *non-obvious* outcome matters');
  lines.push('');
  lines.push(
    '   **Always pass a `rationale`** — one sentence on why a future agent needs this. ' +
      "If you can't articulate why it matters, don't suggest it. " +
      'Reviewers read the rationale first; a suggestion without one is usually rejected.',
  );
  lines.push('');
  lines.push(
    '   **Format**: Compact (≤400 chars content). One concept per entry. Prose, not code blocks — ' +
      'include only the non-obvious line(s).\n' +
      '   **Scope** — ask yourself "If a future pod is assigned a completely different task on this profile, does this memory still help them?"\n' +
      '   - `profile` — yes, always true regardless of task (structural invariants, codebase-wide gotchas, auth patterns, architectural constraints)\n' +
      '   - `pod` — no, only relevant to this task or this brief series (path explored, decision made for this PR, gotcha specific to these files)\n' +
      '   - `global` — useful across all repos/profiles (universal tool quirks, cross-cutting patterns)\n' +
      '   When in doubt, prefer `pod` — a narrow profile memory is noise; a well-targeted pod memory is gold.' +
      ' Prefer updating an existing memory over creating a near-duplicate.',
  );
  lines.push(
    '6. **Summarise before finishing**: As your very last step, call `report_task_summary` with:',
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
    '7. **Phases are yours to define**: Name them whatever makes sense for the task. Common patterns:',
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
      'Do NOT run node-gyp directly, install Node headers, modify .npmrc, modify NuGet.config credentials, or change compiler flags.',
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
  lines.push(
    '- **NEVER write credentials into config files.** ' +
      'Do NOT add `ClearTextPassword`, `_authToken`, passwords, PATs, or API keys to ' +
      'NuGet.config, .npmrc, appsettings.json, or any other file in the workspace. ' +
      'Package authentication is pre-configured via environment variables. ' +
      'If `dotnet restore` or `npm install` fails with 401/403 auth errors, ' +
      'call `report_blocker` — do NOT attempt to fix authentication yourself.',
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
      lines.push(
        '- Only WebFetch/curl to the allowed domains above will work. All other external URLs are blocked.',
      );
      lines.push('- Blocked: cloud metadata endpoints, internal services.');
    } else {
      lines.push(
        '- Outbound network access is restricted to package registries and essential services.',
      );
      lines.push('- Use the action tools below for all external data access.');
    }
  } else {
    lines.push('- Network policy is not enforced. You may have general internet access.');
    // Even without a network policy, action-tool domains are served via the control plane
    // and are NOT directly reachable from the container (no credentials, no token).
    const groups = new Set(availableActions.map((a) => a.group));
    const blockedDomains: string[] = [];
    if (groups.has('github-issues') || groups.has('github-prs') || groups.has('github-code')) {
      blockedDomains.push('github.com / api.github.com');
    }
    if (groups.has('ado-workitems') || groups.has('ado-prs') || groups.has('ado-code')) {
      blockedDomains.push('dev.azure.com');
    }
    if (groups.has('azure-logs')) {
      blockedDomains.push('management.azure.com');
    }
    if (blockedDomains.length > 0) {
      lines.push(
        `- **These domains are NOT directly accessible** (no credentials in container): ${blockedDomains.join(', ')}. Do NOT attempt gh CLI, curl, or WebFetch to these domains — they will fail. Use the action tools on the Escalation MCP server instead (see MCP Servers section).`,
      );
    }
  }
  lines.push('');

  // Available Actions section — reference the MCP tools listed above
  if (availableActions.length > 0) {
    lines.push('### External Data Access');

    // Describe which domains are covered by enabled action groups
    const groups = new Set(availableActions.map((a) => a.group));
    const coveredDomains: string[] = [];
    if (groups.has('github-issues') || groups.has('github-prs') || groups.has('github-code')) {
      const parts: string[] = [];
      if (groups.has('github-issues')) parts.push('issues');
      if (groups.has('github-prs')) parts.push('PRs');
      if (groups.has('github-code')) parts.push('code');
      coveredDomains.push(`GitHub ${parts.join(', ')}`);
    }
    if (groups.has('ado-workitems') || groups.has('ado-prs') || groups.has('ado-code')) {
      const parts: string[] = [];
      if (groups.has('ado-workitems')) parts.push('work items');
      if (groups.has('ado-prs')) parts.push('PRs');
      if (groups.has('ado-code')) parts.push('code');
      coveredDomains.push(`ADO ${parts.join(', ')}`);
    }
    if (groups.has('azure-logs')) {
      coveredDomains.push('Azure logs');
    }
    if (groups.has('azure-pim')) {
      coveredDomains.push('Azure PIM');
    }

    if (coveredDomains.length > 0) {
      lines.push(
        `${coveredDomains.join('; ')} — accessible via the action tools on the Escalation MCP server (see MCP Servers section). You MUST use these MCP action tools for these domains. Do not use WebFetch, curl, gh CLI, or direct API calls as substitutes — actions handle authentication, PII redaction, and audit logging automatically.`,
      );
    } else {
      lines.push(
        'Action tools are available on the Escalation MCP server (see MCP Servers section). ' +
          'Use these instead of WebFetch, curl, or direct API calls — ' +
          'actions handle authentication, PII redaction, and audit logging automatically.',
      );
    }
    // PIM activation details — give the agent the exact values so it doesn't guess
    const pimActivations = profile.pimActivations ?? [];
    if (groups.has('azure-pim') && pimActivations.length > 0) {
      lines.push('### Azure PIM — Pre-configured Activations');
      lines.push(
        'The following roles/groups are allowlisted on this profile. Use these **exact** values when calling `activate_pim_role` or `activate_pim_group`. Do NOT attempt to discover or infer scope/ID values — use only what is listed here.',
      );
      lines.push('');
      for (const entry of pimActivations) {
        if (entry.type === 'rbac_role') {
          const label = entry.displayName ?? 'RBAC Role';
          lines.push(`- **${label}** (RBAC Role)`);
          lines.push(`  - scope: \`${entry.scope}\``);
          lines.push(`  - role_definition_id: \`${entry.roleDefinitionId}\``);
          if (entry.duration) lines.push(`  - duration: ${entry.duration}`);
        } else {
          const label = entry.displayName ?? 'Entra Group';
          lines.push(`- **${label}** (Group)`);
          lines.push(`  - group_id: \`${entry.groupId}\``);
          if (entry.duration) lines.push(`  - duration: ${entry.duration}`);
        }
      }
      lines.push('');
    }

    lines.push('');
  }

  // What You Cannot Do
  lines.push('### What You Cannot Do');
  lines.push('- Access external APIs directly (use the action tools on the Escalation MCP server)');
  lines.push('- Read files from repos other than your worktree (use read_file action instead)');
  lines.push('- See real email addresses or usernames (they are masked for privacy)');
  lines.push(
    '- Extract, copy, or embed credentials from environment variables into any file. ' +
      'Package auth is handled automatically — never read `VSS_NUGET_EXTERNAL_FEED_ENDPOINTS`, ' +
      '`.npmrc` tokens, or similar env vars to write into workspace files.',
  );
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

/**
 * Sort memories for the index: pod first, then profile, then global.
 * Within each scope, most recently updated entries come first.
 */
export function sortMemoriesForIndex(memories: MemoryEntry[]): MemoryEntry[] {
  const scopeOrder: Record<string, number> = { pod: 0, profile: 1, global: 2 };
  return [...memories].sort((a, b) => {
    const scopeDiff = (scopeOrder[a.scope] ?? 2) - (scopeOrder[b.scope] ?? 2);
    if (scopeDiff !== 0) return scopeDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
