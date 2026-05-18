import type { HistoryExportStats, RuntimeType } from '@autopod/shared';

export interface HistoryInstructionTarget {
  path: string;
  fileName: string;
  agentName: string;
}

/**
 * Pick the runtime-native instruction file for the history analysis workspace.
 */
export function getHistoryInstructionTarget(runtime: RuntimeType): HistoryInstructionTarget {
  switch (runtime) {
    case 'codex':
      return { path: '/workspace/AGENTS.md', fileName: 'AGENTS.md', agentName: 'Codex' };
    case 'copilot':
      return {
        path: '/workspace/.github/copilot-instructions.md',
        fileName: '.github/copilot-instructions.md',
        agentName: 'Copilot',
      };
    default:
      return { path: '/workspace/CLAUDE.md', fileName: 'CLAUDE.md', agentName: 'Claude Code' };
  }
}

/**
 * Generate runtime-native instructions for the history analysis workspace container.
 */
export function generateHistoryInstructions(
  stats: HistoryExportStats,
  target: Pick<HistoryInstructionTarget, 'fileName' | 'agentName'> = {
    fileName: 'CLAUDE.md',
    agentName: 'Claude Code',
  },
): string {
  const failedCount = (stats.byStatus.failed ?? 0) + (stats.byStatus.killed ?? 0);
  const failureRate =
    stats.totalSessions > 0 ? ((failedCount / stats.totalSessions) * 100).toFixed(1) : '0.0';

  return `# Autopod History Analysis Workspace

You are ${target.agentName} in a history analysis workspace. Your goal is to help
investigate patterns across past Autopod runs and provide actionable recommendations.

## Dataset
- **${stats.totalSessions} pods** loaded into \`/history/history.db\`
- **${failedCount} failed** (${failureRate}% failure rate)
- **$${stats.totalCost.toFixed(2)}** total cost

## Available Data

| File | Description |
|------|-------------|
| \`/history/history.db\` | SQLite database — pods, validations, escalations, errors, progress_events |
| \`/history/summary.md\` | High-level stats overview |
| \`/history/analysis-guide.md\` | Database schema, example SQL queries, analysis tips |

## Quick Start

\`\`\`bash
# Open the database
sqlite3 /history/history.db

# See table schemas
.schema

# Quick overview
SELECT status, COUNT(*) FROM pods GROUP BY status;
SELECT profile_name, COUNT(*) FROM pods GROUP BY profile_name;
\`\`\`

## Your Goals

1. **Find recurring failure patterns** — same build errors, same review issues across pods
2. **Identify agent confusion** — frequent escalations, repeated rework on the same issue
3. **Spot token waste** — expensive pods with poor outcomes
4. **Suggest agent-instruction improvements** — with specific text snippets to add
5. **Propose skill ideas** — reusable slash commands that prevent common issues
6. **Flag profile config issues** — validation settings, acceptance criteria, build commands

## Output Format

When you find a pattern, present it as:

### Pattern: [Title]
- **Frequency**: X of Y pods
- **Impact**: [high/medium/low]
- **Details**: What's happening
- **Recommendation**: What to change

#### Suggested ${target.fileName} addition (if applicable):
\`\`\`markdown
## [Section title]
[Content to add to the project's ${target.fileName}]
\`\`\`

Read \`/history/analysis-guide.md\` for the full database schema and example queries.
`;
}
