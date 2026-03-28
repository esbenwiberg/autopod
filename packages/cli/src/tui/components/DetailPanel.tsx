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
            {session.filesChanged} changed, +{session.linesAdded} -{session.linesRemoved}
          </Text>
        </Box>
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
                    .map((line, i) => (
                      <Text key={i} dimColor wrap="truncate">
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
                .map((page, i) => (
                  <Box key={i} flexDirection="column">
                    <Text color="red">Page {page.path} failed:</Text>
                    {page.assertions
                      .filter((a) => !a.passed)
                      .map((a, j) => (
                        <Text key={j} dimColor wrap="truncate">
                          {`  ${a.type} ${a.selector}: expected "${a.expected}" got "${a.actual}"`}
                        </Text>
                      ))}
                    {page.consoleErrors.map((e, j) => (
                      <Text key={j} dimColor wrap="truncate">
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
                .map((r, i) => (
                  <Box key={i} flexDirection="column" marginLeft={2}>
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
                  {validation.taskReview.issues.map((issue, i) => (
                    <Text key={i} color="red" wrap="truncate">
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
