import type { AgentEvent, Session, ValidationResult } from '@autopod/shared';
import { Box, Text } from 'ink';
import type React from 'react';
import { truncate } from '../utils/truncate.js';
import { ActivityFeed } from './ActivityFeed.js';
import { MetricsBar } from './MetricsBar.js';
import { PlanPanel } from './PlanPanel.js';
import { ProgressBar } from './ProgressBar.js';
import { StatusBadge } from './StatusBadge.js';

interface DetailPanelProps {
  session: Session | null;
  events: AgentEvent[];
  maxActivityLines: number;
  /** Override the displayed validation (for attempt navigation). Falls back to session.lastValidationResult. */
  displayedValidation?: ValidationResult | null;
  /** Total number of validation attempts (for "Attempt X/Y" display). */
  totalAttempts?: number;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${seconds}s`;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function DetailPanel({
  session,
  events,
  maxActivityLines,
  displayedValidation,
  totalAttempts,
}: DetailPanelProps): React.ReactElement {
  if (!session) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Select a session to view details</Text>
      </Box>
    );
  }

  const validation = displayedValidation ?? session.lastValidationResult;

  // Derive live file count from agent events for running sessions (DB stats are only
  // populated at completion, so they show 0 during execution).
  const liveUniqueFiles = new Set(
    events
      .filter((e): e is import('@autopod/shared').AgentFileChangeEvent => e.type === 'file_change')
      .map((e) => e.path),
  ).size;
  const displayFiles =
    session.filesChanged > 0 ? `${session.filesChanged} changed` : `${liveUniqueFiles} changed`;
  const displayLines =
    session.filesChanged > 0
      ? `, +${session.linesAdded} -${session.linesRemoved}`
      : liveUniqueFiles > 0
        ? ''
        : `, +${session.linesAdded} -${session.linesRemoved}`;

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold>Session {session.id}</Text>
        <StatusBadge status={session.status} />
      </Box>

      {/* Details grid */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text dimColor>{'Task:     '}</Text>
          <Text wrap="truncate">{session.task.split('\n')[0]}</Text>
        </Box>
        {session.acceptanceCriteria && session.acceptanceCriteria.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>
              {'AC:       '}
              {session.acceptanceCriteria.length} criteria
            </Text>
          </Box>
        )}
        <Box>
          <Text dimColor>{'Model:    '}</Text>
          <Text>{session.model}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Profile:  '}</Text>
          <Text>{session.profileName}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Branch:   '}</Text>
          <Text>{session.branch || '-'}</Text>
        </Box>
        {session.prUrl && (
          <Box>
            <Text dimColor>{'PR:       '}</Text>
            <Text color="blue">{session.prUrl}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor>{'Duration: '}</Text>
          <Text>{formatDuration(session.startedAt, session.completedAt)}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Files:    '}</Text>
          <Text>
            {displayFiles}
            {displayLines}
          </Text>
        </Box>
        {session.commitCount > 0 || session.status === 'running' ? (
          <Box flexDirection="column">
            <Box>
              <Text dimColor>{'Commits:  '}</Text>
              {(() => {
                const runningMins = session.startedAt
                  ? Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60_000)
                  : 0;
                const stale = runningMins >= 30 && session.commitCount === 0;
                const lastAgo = session.lastCommitAt
                  ? formatElapsed(Date.now() - new Date(session.lastCommitAt).getTime())
                  : null;
                const pace =
                  runningMins > 0 && session.commitCount > 0
                    ? ((session.commitCount / runningMins) * 60).toFixed(1)
                    : null;
                // Visual dot timeline: up to 10 dots, filled per commit
                const maxDots = 10;
                const filled = Math.min(session.commitCount, maxDots);
                const empty = maxDots - filled;
                const dots = '\u25CF'.repeat(filled) + '\u25CB'.repeat(empty);
                const color = stale ? 'yellow' : session.commitCount > 0 ? 'green' : undefined;
                return (
                  <Box flexDirection="column">
                    <Box gap={1}>
                      <Text color={color}>{dots}</Text>
                      <Text color={color}>
                        {session.commitCount}
                        {pace ? ` (~${pace}/hr)` : ''}
                      </Text>
                    </Box>
                    {lastAgo && (
                      <Text dimColor>
                        {'          '}last {lastAgo} ago
                      </Text>
                    )}
                    {stale && (
                      <Text color="yellow">{'          '}no commits yet — agent may be stuck</Text>
                    )}
                  </Box>
                );
              })()}
            </Box>
          </Box>
        ) : null}
        {(session.status === 'running' ||
          session.status === 'paused' ||
          session.costUsd > 0 ||
          session.inputTokens > 0) && (
          <Box>
            <Text dimColor>{'Tokens:   '}</Text>
            <Text dimColor={session.inputTokens === 0}>
              {formatTokens(session.inputTokens)}
              <Text dimColor>\u2191 </Text>
              {formatTokens(session.outputTokens)}
              <Text dimColor>\u2193</Text>
            </Text>
            {session.costUsd > 0 || session.status === 'running' || session.status === 'paused' ? (
              <Text dimColor={session.costUsd === 0}>
                {' '}
                <Text dimColor>— $</Text>
                {session.costUsd.toFixed(3)}
              </Text>
            ) : null}
          </Box>
        )}
        {session.linkedSessionId && (
          <Box>
            <Text dimColor>{'Linked:   '}</Text>
            <Text color="cyan">
              {'\u21C6'} {session.linkedSessionId}
            </Text>
            <Text dimColor> (press [g] to jump)</Text>
          </Box>
        )}
        {session.previewUrl ? (
          <Box>
            <Text dimColor>{'Preview:  '}</Text>
            <Text color="blue">{session.previewUrl}</Text>
          </Box>
        ) : (
          session.containerId &&
          ['validated', 'failed'].includes(session.status) && (
            <Box>
              <Text dimColor>{'Preview:  '}</Text>
              <Text color="yellow">stopped</Text>
              <Text dimColor> (press [o] to launch)</Text>
            </Box>
          )
        )}
      </Box>

      {/* Progress bar */}
      {session.progress && (
        <Box marginTop={1}>
          <ProgressBar
            currentPhase={session.progress.currentPhase}
            totalPhases={session.progress.totalPhases}
            phase={session.progress.phase}
            description={session.progress.description}
          />
        </Box>
      )}

      {/* Plan */}
      {session.plan && (
        <Box marginTop={1}>
          <PlanPanel
            summary={session.plan.summary}
            steps={session.plan.steps}
            currentPhase={session.progress?.currentPhase}
          />
        </Box>
      )}

      {/* Metrics */}
      {(session.status === 'running' || session.status === 'paused') && (
        <Box marginTop={1}>
          <MetricsBar
            events={events}
            startedAt={session.startedAt}
            completedAt={session.completedAt}
            filesChanged={session.filesChanged}
            linesAdded={session.linesAdded}
            linesRemoved={session.linesRemoved}
            costUsd={session.costUsd}
            inputTokens={session.inputTokens}
            outputTokens={session.outputTokens}
          />
        </Box>
      )}

      {/* Validation summary */}
      {validation && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold dimColor>
              Validation (attempt {validation.attempt}
              {totalAttempts && totalAttempts > 1 ? `/${totalAttempts}` : ''})
            </Text>
            {totalAttempts && totalAttempts > 1 && (
              <Text dimColor>
                {' '}
                [{'<'}] [{'>'} ] to navigate
              </Text>
            )}
          </Box>
          <Box>
            <Text dimColor>{'Result:   '}</Text>
            <Text color={validation.overall === 'pass' ? 'green' : 'red'}>
              {validation.overall.toUpperCase()}
            </Text>
          </Box>
          <Box>
            <Text dimColor>{'Smoke:    '}</Text>
            <Text color={validation.smoke.status === 'pass' ? 'green' : 'red'}>
              {validation.smoke.status}
            </Text>
          </Box>
          {/* Smoke failure details */}
          {validation.smoke.status === 'fail' && (
            <Box flexDirection="column" marginLeft={2}>
              {validation.smoke.build.status === 'fail' && (
                <Box flexDirection="column">
                  <Text color="red">Build failed:</Text>
                  {validation.smoke.build.output
                    .trim()
                    .split('\n')
                    .slice(-8)
                    .map((line) => (
                      <Text key={line} dimColor wrap="truncate">
                        {line}
                      </Text>
                    ))}
                </Box>
              )}
              {validation.smoke.health.status === 'fail' && (
                <Text color="red">
                  Health check failed: {validation.smoke.health.url} → HTTP{' '}
                  {validation.smoke.health.responseCode ?? 'no response'}
                </Text>
              )}
              {validation.smoke.pages
                .filter((p) => p.status === 'fail')
                .map((page) => (
                  <Box key={page.path} flexDirection="column">
                    <Text color="red">Page {page.path} failed:</Text>
                    {page.assertions
                      .filter((a) => !a.passed)
                      .map((a) => (
                        <Text key={`${a.type}-${a.selector}`} dimColor wrap="truncate">
                          {`  ${a.type} ${a.selector}: expected "${a.expected}" got "${a.actual}"`}
                        </Text>
                      ))}
                    {page.consoleErrors.map((e) => (
                      <Text key={e} dimColor wrap="truncate">
                        {`  console: ${e}`}
                      </Text>
                    ))}
                  </Box>
                ))}
            </Box>
          )}
          {/* AC validation results */}
          {validation.acValidation && validation.acValidation.status !== 'skip' && (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>{'AC Check: '}</Text>
                <Text color={validation.acValidation.status === 'pass' ? 'green' : 'red'}>
                  {validation.acValidation.status}
                </Text>
                <Text dimColor>
                  {' '}
                  ({validation.acValidation.results.filter((r) => r.passed).length}/
                  {validation.acValidation.results.length} passed)
                </Text>
              </Box>
              {validation.acValidation.results
                .filter((r) => !r.passed)
                .map((r) => (
                  <Box key={r.criterion} flexDirection="column" marginLeft={2}>
                    <Text color="red" wrap="truncate">
                      ✗ {r.criterion}
                    </Text>
                    {r.reasoning && (
                      <Text dimColor wrap="truncate">
                        {'  '}
                        {r.reasoning}
                      </Text>
                    )}
                  </Box>
                ))}
            </Box>
          )}
          {validation.taskReview && (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>{'Review:   '}</Text>
                <Text
                  color={
                    validation.taskReview.status === 'pass'
                      ? 'green'
                      : validation.taskReview.status === 'fail'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {validation.taskReview.status}
                </Text>
              </Box>
              {validation.taskReview.status !== 'pass' && (
                <Box flexDirection="column" marginLeft={2}>
                  {validation.taskReview.reasoning && (
                    <Text dimColor wrap="wrap">
                      {validation.taskReview.reasoning}
                    </Text>
                  )}
                  {validation.taskReview.issues.map((issue) => (
                    <Text key={issue} color="red" wrap="truncate">
                      {`• ${issue}`}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}

      {/* Pending escalation question */}
      {session.pendingEscalation?.type === 'ask_human' && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="yellow">
          <Text bold color="yellow">
            Agent is asking:
          </Text>
          <Text wrap="wrap">
            {'question' in session.pendingEscalation.payload
              ? session.pendingEscalation.payload.question
              : ''}
          </Text>
          {'context' in session.pendingEscalation.payload &&
            session.pendingEscalation.payload.context && (
              <Text dimColor wrap="wrap">
                {session.pendingEscalation.payload.context}
              </Text>
            )}
          <Text dimColor>Press [t] to respond</Text>
        </Box>
      )}

      {/* Activity feed */}
      <Box marginTop={1}>
        <ActivityFeed events={events} maxLines={maxActivityLines} />
      </Box>
    </Box>
  );
}
