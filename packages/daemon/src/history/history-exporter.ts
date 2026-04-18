import type {
  AgentActivityEvent,
  AgentErrorEvent,
  HistoryExportStats,
  HistoryQuery,
  Pod,
  PodStatus,
  ValidationResult,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { EscalationRepository } from '../pods/escalation-repository.js';
import type { EventRepository } from '../pods/event-repository.js';
import type { PodRepository } from '../pods/pod-repository.js';
import type { ProgressEventRepository } from '../pods/progress-event-repository.js';
import type { ValidationRepository } from '../pods/validation-repository.js';

export interface HistoryExportResult {
  dbBuffer: Buffer;
  summary: string;
  analysisGuide: string;
  stats: HistoryExportStats;
}

interface ExporterDeps {
  podRepo: PodRepository;
  validationRepo: ValidationRepository;
  escalationRepo: EscalationRepository;
  eventRepo: EventRepository;
  progressEventRepo: ProgressEventRepository;
  actionAuditRepo?: ActionAuditRepository;
}

const HISTORY_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS pods (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  validation_attempts INTEGER NOT NULL DEFAULT 0,
  max_validation_attempts INTEGER NOT NULL DEFAULT 3,
  rework_reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  plan TEXT,
  task_summary TEXT,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  commit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  overall TEXT NOT NULL,
  failed_phases TEXT,
  build_error TEXT,
  review_issues TEXT,
  review_reasoning TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  type TEXT NOT NULL,
  question TEXT,
  response TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  message TEXT NOT NULL,
  fatal INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  description TEXT NOT NULL,
  current_phase INTEGER NOT NULL,
  total_phases INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

function computeDurationSeconds(pod: Pod): number | null {
  if (!pod.startedAt) return null;
  const end = pod.completedAt ?? new Date().toISOString();
  return Math.round((new Date(end).getTime() - new Date(pod.startedAt).getTime()) / 1000);
}

function extractFailedPhases(result: ValidationResult): string[] {
  const phases: string[] = [];
  if (result.smoke.build.status === 'fail') phases.push('build');
  if (result.smoke.health.status === 'fail') phases.push('health');
  for (const page of result.smoke.pages) {
    if (page.status === 'fail') phases.push(`smoke:${page.path}`);
  }
  if (result.test?.status === 'fail') phases.push('test');
  if (result.acValidation?.status === 'fail') phases.push('ac_validation');
  if (result.taskReview?.status === 'fail') phases.push('review');
  return phases;
}

function extractBuildError(result: ValidationResult): string | null {
  if (result.smoke.build.status !== 'fail') return null;
  const output = result.smoke.build.output;
  // Take last meaningful line (usually the actual error)
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-3).join('\n').slice(0, 500) || null;
}

function extractReviewIssues(result: ValidationResult): string[] | null {
  if (!result.taskReview) return null;
  if (result.taskReview.issues.length === 0) return null;
  return result.taskReview.issues;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

export function createHistoryExporter(deps: ExporterDeps) {
  return {
    export(query: HistoryQuery): HistoryExportResult {
      // 1. Fetch pods with filters
      const allSessions = deps.podRepo.list({
        profileName: query.profileName,
        status: query.failuresOnly ? ('failed' as PodStatus) : undefined,
      });

      let pods = allSessions;

      // Apply 'since' filter
      if (query.since) {
        const sinceDate = new Date(query.since).getTime();
        pods = pods.filter((s) => new Date(s.createdAt).getTime() >= sinceDate);
      }

      // Also include killed and review_required pods when filtering failures
      if (query.failuresOnly) {
        const additionalStatuses: PodStatus[] = ['killed', 'review_required'];
        for (const status of additionalStatuses) {
          const extra = deps.podRepo
            .list({
              profileName: query.profileName,
              status,
            })
            .filter(
              (s) =>
                !query.since || new Date(s.createdAt).getTime() >= new Date(query.since).getTime(),
            );
          pods = [...pods, ...extra];
        }
      }

      // Apply limit
      const limit = query.limit ?? 100;
      pods = pods.slice(0, limit);

      // 2. Create in-memory history DB
      const historyDb = new Database(':memory:');
      historyDb.exec(HISTORY_DB_SCHEMA);

      const insertSession = historyDb.prepare(`
        INSERT INTO pods (id, profile_name, task, status, model, runtime,
          validation_attempts, max_validation_attempts, rework_reason,
          input_tokens, output_tokens, cost_usd,
          files_changed, lines_added, lines_removed,
          duration_seconds, plan, task_summary, escalation_count, commit_count,
          created_at, started_at, completed_at)
        VALUES (@id, @profileName, @task, @status, @model, @runtime,
          @validationAttempts, @maxValidationAttempts, @reworkReason,
          @inputTokens, @outputTokens, @costUsd,
          @filesChanged, @linesAdded, @linesRemoved,
          @durationSeconds, @plan, @taskSummary, @escalationCount, @commitCount,
          @createdAt, @startedAt, @completedAt)
      `);

      const insertValidation = historyDb.prepare(`
        INSERT INTO validations (pod_id, attempt, overall, failed_phases, build_error,
          review_issues, review_reasoning, created_at)
        VALUES (@podId, @attempt, @overall, @failedPhases, @buildError,
          @reviewIssues, @reviewReasoning, @createdAt)
      `);

      const insertEscalation = historyDb.prepare(`
        INSERT INTO escalations (pod_id, type, question, response, created_at, resolved_at)
        VALUES (@podId, @type, @question, @response, @createdAt, @resolvedAt)
      `);

      const insertError = historyDb.prepare(`
        INSERT INTO errors (pod_id, message, fatal, timestamp)
        VALUES (@podId, @message, @fatal, @timestamp)
      `);

      const insertProgress = historyDb.prepare(`
        INSERT INTO progress_events (pod_id, phase, description, current_phase, total_phases, created_at)
        VALUES (@podId, @phase, @description, @currentPhase, @totalPhases, @createdAt)
      `);

      // 3. Populate history DB
      for (const pod of pods) {
        insertSession.run({
          id: pod.id,
          profileName: pod.profileName,
          task: truncate(pod.task, 500),
          status: pod.status,
          model: pod.model,
          runtime: pod.runtime,
          validationAttempts: pod.validationAttempts,
          maxValidationAttempts: pod.maxValidationAttempts,
          reworkReason: pod.reworkReason,
          inputTokens: pod.inputTokens,
          outputTokens: pod.outputTokens,
          costUsd: pod.costUsd,
          filesChanged: pod.filesChanged,
          linesAdded: pod.linesAdded,
          linesRemoved: pod.linesRemoved,
          durationSeconds: computeDurationSeconds(pod),
          plan: pod.plan ? JSON.stringify(pod.plan) : null,
          taskSummary: pod.taskSummary ? JSON.stringify(pod.taskSummary) : null,
          escalationCount: pod.escalationCount,
          commitCount: pod.commitCount,
          createdAt: pod.createdAt,
          startedAt: pod.startedAt,
          completedAt: pod.completedAt,
        });

        // Validations
        const validations = deps.validationRepo.getForSession(pod.id);
        for (const v of validations) {
          const failedPhases = extractFailedPhases(v.result);
          insertValidation.run({
            podId: pod.id,
            attempt: v.attempt,
            overall: v.result.overall,
            failedPhases: failedPhases.length > 0 ? failedPhases.join(', ') : null,
            buildError: extractBuildError(v.result),
            reviewIssues: extractReviewIssues(v.result)
              ? JSON.stringify(extractReviewIssues(v.result))
              : null,
            reviewReasoning: v.result.taskReview?.reasoning
              ? truncate(v.result.taskReview.reasoning, 1000)
              : null,
            createdAt: v.createdAt,
          });
        }

        // Escalations
        const escalations = deps.escalationRepo.listBySession(pod.id);
        for (const esc of escalations) {
          const question =
            'question' in esc.payload
              ? (esc.payload as { question: string }).question
              : 'description' in esc.payload
                ? (esc.payload as { description: string }).description
                : '';
          insertEscalation.run({
            podId: pod.id,
            type: esc.type,
            question: truncate(question, 500),
            response: esc.response ? truncate(JSON.stringify(esc.response), 500) : null,
            createdAt: esc.createdAt,
            resolvedAt: esc.resolvedAt,
          });
        }

        // Errors (from event stream)
        const events = deps.eventRepo.getForSession(pod.id);
        for (const evt of events) {
          if (evt.type === 'pod.agent_activity') {
            const activityEvent = evt.payload as AgentActivityEvent;
            if (activityEvent.event.type === 'error') {
              const errorEvent = activityEvent.event as AgentErrorEvent;
              insertError.run({
                podId: pod.id,
                message: truncate(errorEvent.message, 500),
                fatal: errorEvent.fatal ? 1 : 0,
                timestamp: errorEvent.timestamp,
              });
            }
          }
        }

        // Progress events
        const progressEvents = deps.progressEventRepo.listBySession(pod.id);
        for (const pe of progressEvents) {
          insertProgress.run({
            podId: pod.id,
            phase: pe.phase,
            description: truncate(pe.description, 300),
            currentPhase: pe.currentPhase,
            totalPhases: pe.totalPhases,
            createdAt: pe.createdAt,
          });
        }
      }

      // 4. Compute stats
      const stats = computeStats(pods);

      // 5. Serialize the in-memory DB to a buffer
      const dbBuffer = Buffer.from(historyDb.serialize());
      historyDb.close();

      // 6. Generate summary + analysis guide
      const summary = generateSummary(pods, stats);
      const analysisGuide = generateAnalysisGuide();

      return { dbBuffer, summary, analysisGuide, stats };
    },
  };
}

function computeStats(pods: Pod[]): HistoryExportStats {
  const byStatus: Record<string, number> = {};
  let totalCost = 0;

  for (const s of pods) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    totalCost += s.costUsd;
  }

  return {
    totalSessions: pods.length,
    byStatus,
    totalCost,
  };
}

function generateSummary(pods: Pod[], stats: HistoryExportStats): string {
  const failedCount = (stats.byStatus.failed ?? 0) + (stats.byStatus.killed ?? 0);
  const completeCount = stats.byStatus.complete ?? 0;
  const failureRate =
    stats.totalSessions > 0 ? ((failedCount / stats.totalSessions) * 100).toFixed(1) : '0.0';

  // Per-profile breakdown
  const profiles = new Map<
    string,
    { total: number; failed: number; cost: number; valAttempts: number }
  >();
  for (const s of pods) {
    const p = profiles.get(s.profileName) ?? { total: 0, failed: 0, cost: 0, valAttempts: 0 };
    p.total++;
    if (s.status === 'failed' || s.status === 'killed' || s.status === 'review_required')
      p.failed++;
    p.cost += s.costUsd;
    p.valAttempts += s.validationAttempts;
    profiles.set(s.profileName, p);
  }

  let profileSection = '';
  for (const [name, p] of profiles) {
    const avgVal = p.total > 0 ? (p.valAttempts / p.total).toFixed(1) : '0';
    const rate = p.total > 0 ? ((p.failed / p.total) * 100).toFixed(0) : '0';
    profileSection += `- **${name}**: ${p.total} pods, ${p.failed} failed (${rate}%), avg ${avgVal} validation attempts, $${p.cost.toFixed(2)} total cost\n`;
  }

  return `# Pod History Summary

## Overview
- **Total pods**: ${stats.totalSessions}
- **Completed**: ${completeCount}
- **Failed/Killed**: ${failedCount}
- **Failure rate**: ${failureRate}%
- **Total cost**: $${stats.totalCost.toFixed(2)}

## By Profile
${profileSection || '- No profiles found'}

## Status Breakdown
${Object.entries(stats.byStatus)
  .sort(([, a], [, b]) => b - a)
  .map(([status, count]) => `- ${status}: ${count}`)
  .join('\n')}

## How to Use This Data
Open \`history.db\` with sqlite3 and run queries. See \`analysis-guide.md\` for examples.

\`\`\`bash
sqlite3 /history/history.db
\`\`\`
`;
}

function generateAnalysisGuide(): string {
  return `# History Analysis Guide

## Database Schema

### pods
Core pod data — one row per pod run.
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Pod ID |
| profile_name | TEXT | Profile used |
| task | TEXT | Task description |
| status | TEXT | Final status (complete, failed, killed, etc.) |
| model | TEXT | AI model used |
| runtime | TEXT | Runtime (claude, codex, copilot) |
| validation_attempts | INT | Number of validation attempts |
| max_validation_attempts | INT | Max allowed |
| rework_reason | TEXT | Why agent was asked to rework (null if N/A) |
| input_tokens | INT | Input tokens consumed |
| output_tokens | INT | Output tokens consumed |
| cost_usd | REAL | Total cost in USD |
| files_changed | INT | Number of files modified |
| lines_added | INT | Lines added |
| lines_removed | INT | Lines removed |
| duration_seconds | INT | Total duration |
| plan | TEXT | Agent's plan (JSON: {summary, steps[]}) |
| task_summary | TEXT | Agent's summary with deviations (JSON) |
| escalation_count | INT | Number of escalations |
| commit_count | INT | Number of commits |
| created_at | TEXT | ISO timestamp |

### validations
One row per validation attempt per pod.
| Column | Type | Description |
|--------|------|-------------|
| pod_id | TEXT | Links to pods.id |
| attempt | INT | Attempt number (1, 2, 3...) |
| overall | TEXT | 'pass' or 'fail' |
| failed_phases | TEXT | Comma-separated: build, health, smoke:/path, review |
| build_error | TEXT | Last lines of build error output |
| review_issues | TEXT | JSON array of AI reviewer issues |
| review_reasoning | TEXT | AI reviewer's reasoning |

### escalations
Agent requests for human or AI help.
| Column | Type | Description |
|--------|------|-------------|
| pod_id | TEXT | Links to pods.id |
| type | TEXT | ask_human, ask_ai, report_blocker |
| question | TEXT | What the agent asked |
| response | TEXT | Human/AI response |
| resolved_at | TEXT | When resolved (null if pending) |

### errors
Fatal and non-fatal errors from agent execution.
| Column | Type | Description |
|--------|------|-------------|
| pod_id | TEXT | Links to pods.id |
| message | TEXT | Error message |
| fatal | INT | 1 if fatal, 0 otherwise |
| timestamp | TEXT | ISO timestamp |

### progress_events
Agent-reported phase transitions.
| Column | Type | Description |
|--------|------|-------------|
| pod_id | TEXT | Links to pods.id |
| phase | TEXT | Phase name |
| description | TEXT | What the agent is doing |
| current_phase | INT | Current phase number |
| total_phases | INT | Total phases planned |

## Example Queries

### Failure Analysis

\`\`\`sql
-- Failure rate by profile
SELECT profile_name,
  COUNT(*) as total,
  SUM(CASE WHEN status IN ('failed', 'killed', 'review_required') THEN 1 ELSE 0 END) as failures,
  ROUND(SUM(CASE WHEN status IN ('failed', 'killed', 'review_required') THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as failure_pct
FROM pods
GROUP BY profile_name
ORDER BY failure_pct DESC;

-- Most common build errors
SELECT build_error, COUNT(*) as occurrences
FROM validations
WHERE overall = 'fail' AND build_error IS NOT NULL
GROUP BY build_error
ORDER BY occurrences DESC
LIMIT 10;

-- Sessions that exhausted all validation attempts
SELECT s.id, s.profile_name, s.task, s.validation_attempts, s.rework_reason
FROM pods s
WHERE s.validation_attempts >= s.max_validation_attempts AND s.status IN ('failed', 'review_required');

-- Most common failed phases
SELECT failed_phases, COUNT(*) as occurrences
FROM validations
WHERE overall = 'fail' AND failed_phases IS NOT NULL
GROUP BY failed_phases
ORDER BY occurrences DESC;
\`\`\`

### Escalation Patterns

\`\`\`sql
-- Escalation frequency by type
SELECT type, COUNT(*) as total FROM escalations GROUP BY type;

-- Most common questions agents ask humans
SELECT question, COUNT(*) as times_asked
FROM escalations
WHERE type = 'ask_human'
GROUP BY question
ORDER BY times_asked DESC
LIMIT 10;

-- Sessions with most escalations
SELECT s.id, s.profile_name, s.task, s.escalation_count
FROM pods s
WHERE s.escalation_count > 0
ORDER BY s.escalation_count DESC
LIMIT 10;
\`\`\`

### Cost & Efficiency

\`\`\`sql
-- Most expensive pods
SELECT id, profile_name, task, cost_usd, status, validation_attempts
FROM pods
ORDER BY cost_usd DESC
LIMIT 10;

-- Average cost by outcome
SELECT status,
  COUNT(*) as pods,
  ROUND(AVG(cost_usd), 2) as avg_cost,
  ROUND(SUM(cost_usd), 2) as total_cost
FROM pods
GROUP BY status
ORDER BY avg_cost DESC;

-- Token waste: high-cost pods that failed
SELECT id, profile_name, task, cost_usd, validation_attempts, rework_reason
FROM pods
WHERE status IN ('failed', 'killed') AND cost_usd > 0
ORDER BY cost_usd DESC;
\`\`\`

### Rework Loops

\`\`\`sql
-- Sessions with multiple validation attempts
SELECT s.id, s.profile_name, s.task, s.validation_attempts,
  GROUP_CONCAT(v.failed_phases, ' | ') as all_failures
FROM pods s
JOIN validations v ON v.pod_id = s.id AND v.overall = 'fail'
WHERE s.validation_attempts > 1
GROUP BY s.id
ORDER BY s.validation_attempts DESC;

-- Common rework reasons
SELECT rework_reason, COUNT(*) as occurrences
FROM pods
WHERE rework_reason IS NOT NULL
GROUP BY rework_reason
ORDER BY occurrences DESC;
\`\`\`

### Agent Confusion Indicators

\`\`\`sql
-- Sessions with errors
SELECT s.id, s.profile_name, e.message, e.fatal
FROM errors e
JOIN pods s ON s.id = e.pod_id
ORDER BY e.timestamp DESC;

-- Task deviations (where agent deviated from plan)
SELECT id, profile_name, task, task_summary
FROM pods
WHERE task_summary IS NOT NULL
  AND json_extract(task_summary, '$.deviations') IS NOT NULL
  AND json_array_length(json_extract(task_summary, '$.deviations')) > 0;
\`\`\`

## What to Look For

1. **Recurring build errors**: Same error across multiple pods → update CLAUDE.md with build fix guidance
2. **Frequent escalations**: Same question asked repeatedly → document the answer in CLAUDE.md or create a skill
3. **Validation rework loops**: Sessions that fail validation multiple times on the same issue → add clearer acceptance criteria
4. **High-cost failures**: Expensive pods that ultimately fail → investigate if task scope is too ambitious
5. **Agent deviations**: Frequent plan deviations → improve task descriptions or system instructions
6. **Profile-specific patterns**: One profile failing more than others → review its configuration

## Recommendations Format

When you find a pattern, suggest one of:
- **CLAUDE.md update**: Specific text to add/change in the project's CLAUDE.md
- **Skill idea**: A reusable slash command that could prevent the issue
- **Profile config change**: Adjustments to validation, build commands, or acceptance criteria
- **Task description improvement**: How to write better task descriptions
`;
}
