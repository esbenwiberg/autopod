import type { HistoryExportStats } from '@autopod/shared';

/**
 * Generate a CLAUDE.md for the history analysis workspace container.
 * This file is placed at /workspace/CLAUDE.md and guides Claude Code
 * on how to analyze the session history data.
 */
export function generateHistoryInstructions(stats: HistoryExportStats): string {
  const failedCount = (stats.byStatus.failed ?? 0) + (stats.byStatus.killed ?? 0);
  const failureRate =
    stats.totalSessions > 0 ? ((failedCount / stats.totalSessions) * 100).toFixed(1) : '0.0';

  return `# Autopod History Analysis Workspace

You are in a history analysis workspace. Your goal is to help investigate patterns
across past pod sessions and provide actionable recommendations.

## Dataset
- **${stats.totalSessions} sessions** loaded into \`/history/history.db\`
- **${failedCount} failed** (${failureRate}% failure rate)
- **$${stats.totalCost.toFixed(2)}** total cost

## Available Data

| File | Description |
|------|-------------|
| \`/history/history.db\` | SQLite database — sessions, validations, escalations, errors, progress_events |
| \`/history/summary.md\` | High-level stats overview |
| \`/history/analysis-guide.md\` | Database schema, example SQL queries, analysis tips |

## Quick Start

\`\`\`bash
# Open the database
sqlite3 /history/history.db

# See table schemas
.schema

# Quick overview
SELECT status, COUNT(*) FROM sessions GROUP BY status;
SELECT profile_name, COUNT(*) FROM sessions GROUP BY profile_name;
\`\`\`

## Your Goals

1. **Find recurring failure patterns** — same build errors, same review issues across sessions
2. **Identify agent confusion** — frequent escalations, repeated rework on the same issue
3. **Spot token waste** — expensive sessions with poor outcomes
4. **Suggest CLAUDE.md improvements** — with specific text snippets to add
5. **Propose skill ideas** — reusable slash commands that prevent common issues
6. **Flag profile config issues** — validation settings, acceptance criteria, build commands

## Output Format

When you find a pattern, present it as:

### Pattern: [Title]
- **Frequency**: X of Y sessions
- **Impact**: [high/medium/low]
- **Details**: What's happening
- **Recommendation**: What to change

#### Suggested CLAUDE.md addition (if applicable):
\`\`\`markdown
## [Section title]
[Content to add to the project CLAUDE.md]
\`\`\`

Read \`/history/analysis-guide.md\` for the full database schema and example queries.
`;
}
