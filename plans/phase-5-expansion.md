---
title: "Phase 5: Expansion & Deployment"
status: exploring
published: true
date: 2026-03-15
---

> The finish line. Correction flow teaches agents to learn from mistakes, Codex opens a second runtime, warm images kill cold starts, and Azure deployment packages it all for production. M12–M14 run in parallel. M15 goes last — it deploys everything.

## Parallelism

```mermaid
gantt
    title Phase 5 Milestones
    dateFormat X
    axisFormat %s

    section Parallel
    M12 Correction Flow     :m12, 0, 1
    M13 Codex Runtime       :m13, 0, 1
    M14 Image Warming       :m14, 0, 1

    section Sequential
    M15 Azure Deployment    :m15, 1, 2
```

**M12**, **M13**, and **M14** have no dependencies on each other — three agents can build them simultaneously. **M15** is the final milestone of the entire project. It packages and deploys everything, so it must wait for all other milestones to be complete.

---

## Milestone M12: Correction Flow

**Location**: `packages/daemon/src/sessions/`
**Depends on**: M7 (Session Manager), M8 (Escalation MCP)

The reject → feedback → retry loop. When validation fails or a human rejects a session, structured feedback goes back to the agent so it can fix its work. This is what makes Autopod self-correcting rather than one-shot.

### State Transitions Involved

```mermaid
stateDiagram-v2
    Validating --> Running: validation fails, retries left
    Validating --> Failed: validation fails, no retries left
    Failed --> Running: ap reject (with feedback)
    Validated --> Running: ap reject (wants changes)
```

Every arrow here involves the correction flow: format feedback, build context, resume the agent.

### Component 1: Feedback Formatter

**File**: `packages/daemon/src/sessions/feedback-formatter.ts`

Constructs structured, actionable feedback messages for the agent. The agent receives these as the `message` parameter to `Runtime.resume()`. Different failure types produce different feedback shapes.

```typescript
import type { ValidationResult, EscalationResponse } from '@autopod/shared';

interface FeedbackOptions {
  task: string;               // original task description
  attempt: number;            // current attempt number
  maxAttempts: number;        // max allowed attempts
}

interface ValidationFeedback extends FeedbackOptions {
  type: 'validation_failure';
  result: ValidationResult;
}

interface RejectionFeedback extends FeedbackOptions {
  type: 'human_rejection';
  feedback: string;           // reviewer's written feedback
  previousStatus: 'validated' | 'failed';
}

interface EscalationFeedback {
  type: 'escalation_response';
  question: string;           // the agent's original question
  response: EscalationResponse;
}

type FeedbackInput = ValidationFeedback | RejectionFeedback | EscalationFeedback;

function formatFeedback(input: FeedbackInput): string;
```

#### Validation Failure Template

```typescript
function formatValidationFailure(input: ValidationFeedback): string {
  const { result, task, attempt, maxAttempts } = input;
  const lines: string[] = [];

  lines.push(`## Validation Failed (attempt ${attempt}/${maxAttempts})`);
  lines.push('');
  lines.push(`Your changes did not pass validation. Fix the issues below and try again.`);
  lines.push('');

  // Build errors
  if (result.smoke.build.status === 'fail') {
    lines.push('### Build Errors');
    lines.push('```');
    lines.push(result.smoke.build.output);
    lines.push('```');
    lines.push('');
  }

  // Health check failure
  if (result.smoke.health.status === 'fail') {
    lines.push('### Health Check Failed');
    lines.push(`The app did not respond at \`${result.smoke.health.url}\` within the timeout.`);
    lines.push(`Response code: ${result.smoke.health.responseCode ?? 'none'}`);
    lines.push('');
  }

  // Page-level failures
  const failedPages = result.smoke.pages.filter(p => p.status === 'fail');
  if (failedPages.length > 0) {
    lines.push('### Page Failures');
    for (const page of failedPages) {
      lines.push(`**${page.path}**:`);
      if (page.consoleErrors.length > 0) {
        lines.push('Console errors:');
        for (const err of page.consoleErrors) {
          lines.push(`- ${err}`);
        }
      }
      const failedAssertions = page.assertions.filter(a => !a.passed);
      if (failedAssertions.length > 0) {
        lines.push('Failed assertions:');
        for (const a of failedAssertions) {
          lines.push(`- \`${a.selector}\` (${a.type}): expected \`${a.expected}\`, got \`${a.actual}\``);
        }
      }
      lines.push('');
    }
  }

  // Task review issues
  if (result.taskReview && result.taskReview.status !== 'pass') {
    lines.push('### Task Review Issues');
    lines.push(result.taskReview.reasoning);
    if (result.taskReview.issues.length > 0) {
      lines.push('');
      lines.push('Specific issues:');
      for (const issue of result.taskReview.issues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push('');
  }

  // Reminder of original task
  lines.push('### Original Task');
  lines.push(task);

  return lines.join('\n');
}
```

#### Human Rejection Template

```typescript
function formatHumanRejection(input: RejectionFeedback): string {
  const { feedback, task, previousStatus, attempt, maxAttempts } = input;
  const lines: string[] = [];

  lines.push('## Changes Rejected by Reviewer');
  lines.push('');

  if (previousStatus === 'validated') {
    lines.push('Your changes passed validation but the reviewer wants changes.');
  } else {
    lines.push('The reviewer is giving you another chance after validation failure.');
  }

  lines.push('');
  lines.push('### Reviewer Feedback');
  lines.push(feedback);
  lines.push('');
  lines.push('### Original Task');
  lines.push(task);
  lines.push('');
  lines.push(`Attempt budget reset. You have ${maxAttempts} validation attempts.`);

  return lines.join('\n');
}
```

#### Escalation Response Template

```typescript
function formatEscalationResponse(input: EscalationFeedback): string {
  const { question, response } = input;
  const lines: string[] = [];

  lines.push('## Response to Your Question');
  lines.push('');
  lines.push(`**Your question**: ${question}`);
  lines.push('');
  lines.push(`**Response** (from ${response.respondedBy}${response.model ? `, ${response.model}` : ''}):`);
  lines.push(response.response);

  return lines.join('\n');
}
```

### Component 2: Correction Context Builder

**File**: `packages/daemon/src/sessions/correction-context.ts`

When feeding failures back to the agent, context matters. The agent needs to know what it already did, what failed, and what the expectations are. This module gathers all that context and bundles it with the feedback.

```typescript
import type { Session, ValidationResult, Profile } from '@autopod/shared';

interface CorrectionContext {
  task: string;                    // original task description
  customInstructions: string | null; // profile's CLAUDE.md content
  failedStep: 'build' | 'health' | 'smoke' | 'task_review';
  validationResult: ValidationResult;
  previousDiff: string;           // git diff of what the agent has done so far
  screenshotDescriptions: string[]; // text descriptions of failed screenshots
  attempt: number;
  maxAttempts: number;
}

async function buildCorrectionContext(
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager
): Promise<CorrectionContext>;
```

#### How Context Is Gathered

```typescript
async function buildCorrectionContext(
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager
): Promise<CorrectionContext> {
  // 1. Get the diff from the container's worktree
  const previousDiff = await containerManager.execInContainer(
    session.containerId!,
    ['git', 'diff', 'HEAD~1'],
    { cwd: session.worktreePath! }
  );

  // 2. Determine which step failed first
  const failedStep = determineFailedStep(validationResult);

  // 3. If task review failed, describe screenshots
  //    (We can't send images to the agent — describe what's wrong in text)
  const screenshotDescriptions: string[] = [];
  if (validationResult.taskReview?.status === 'fail') {
    // The task review result already contains text descriptions
    // of what was wrong in each screenshot — use those
    screenshotDescriptions.push(
      ...validationResult.taskReview.issues
    );
  }

  return {
    task: session.task,
    customInstructions: profile.customInstructions,
    failedStep,
    validationResult,
    previousDiff: truncateDiff(previousDiff, MAX_DIFF_LENGTH),
    screenshotDescriptions,
    attempt: session.validationAttempts,
    maxAttempts: session.maxValidationAttempts,
  };
}

function determineFailedStep(result: ValidationResult): CorrectionContext['failedStep'] {
  if (result.smoke.build.status === 'fail') return 'build';
  if (result.smoke.health.status === 'fail') return 'health';
  const hasPageFailure = result.smoke.pages.some(p => p.status === 'fail');
  if (hasPageFailure) return 'smoke';
  return 'task_review';
}

function truncateDiff(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) return diff;
  return diff.slice(0, maxLength) + '\n... (truncated)';
}
```

#### Assembling the Full Correction Message

The feedback formatter and context builder work together. The session manager calls both and combines their output:

```typescript
async function buildCorrectionMessage(
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager
): Promise<string> {
  const context = await buildCorrectionContext(
    session, profile, validationResult, containerManager
  );

  const feedback = formatFeedback({
    type: 'validation_failure',
    result: validationResult,
    task: session.task,
    attempt: session.validationAttempts,
    maxAttempts: session.maxValidationAttempts,
  });

  const lines: string[] = [feedback];

  // Add diff context so agent knows what it already changed
  if (context.previousDiff) {
    lines.push('');
    lines.push('### Your Changes So Far');
    lines.push('```diff');
    lines.push(context.previousDiff);
    lines.push('```');
  }

  // Add custom instructions reminder
  if (context.customInstructions) {
    lines.push('');
    lines.push('### Project Instructions (reminder)');
    lines.push(context.customInstructions);
  }

  return lines.join('\n');
}
```

### Component 3: Retry Logic (Session Manager Updates)

**File**: Updates to `packages/daemon/src/sessions/session-manager.ts`

The session manager gains enhanced validation failure handling and rejection logic.

#### Validation Failure Handler

```typescript
// In session-manager.ts — called when validation completes with a "fail" verdict

async function handleValidationFailure(
  session: Session,
  result: ValidationResult
): Promise<void> {
  // Persist the validation result
  await this.db.updateSession(session.id, {
    lastValidationResult: result,
    validationAttempts: session.validationAttempts + 1,
  });

  await this.db.insertValidation({
    id: nanoid(),
    sessionId: session.id,
    attempt: session.validationAttempts + 1,
    result,
    screenshots: result.taskReview?.screenshots ?? [],
  });

  const updatedSession = {
    ...session,
    validationAttempts: session.validationAttempts + 1,
  };

  if (updatedSession.validationAttempts >= updatedSession.maxValidationAttempts) {
    // No retries left — transition to failed
    await this.transitionSession(session.id, 'failed');
    this.eventBus.emit({
      type: 'session.status_changed',
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      previousStatus: 'validating',
      newStatus: 'failed',
    });

    // Notify human that session failed after max retries
    await this.notifier.notify({
      type: 'session_failed',
      sessionId: session.id,
      profileName: session.profileName,
      task: session.task,
      timestamp: new Date().toISOString(),
      reason: `Validation failed after ${updatedSession.validationAttempts} attempts`,
      validationResult: result,
      screenshotUrl: null,
    });

    this.logger.warn({
      component: 'session-manager',
      sessionId: session.id,
      msg: `Session failed after ${updatedSession.validationAttempts} validation attempts`,
    });
    return;
  }

  // Retries remaining — build correction message and resume agent
  const profile = await this.db.getProfile(session.profileName);
  const correctionMessage = await buildCorrectionMessage(
    updatedSession, profile, result, this.containerManager
  );

  // Transition back to running
  await this.transitionSession(session.id, 'running');
  this.eventBus.emit({
    type: 'session.status_changed',
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    previousStatus: 'validating',
    newStatus: 'running',
  });

  // Resume the agent with correction feedback
  const runtime = this.runtimeRegistry.get(session.runtime);
  const events = runtime.resume(session.id, correctionMessage);
  this.consumeAgentEvents(session.id, events);

  this.logger.info({
    component: 'session-manager',
    sessionId: session.id,
    msg: `Retrying after validation failure (attempt ${updatedSession.validationAttempts}/${updatedSession.maxValidationAttempts})`,
  });
}
```

#### Enhanced Rejection Handler

```typescript
// In session-manager.ts — called when human runs `ap reject <session-id> "feedback"`

async function rejectSession(
  sessionId: string,
  feedback: string
): Promise<void> {
  const session = await this.db.getSession(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);

  // Rejection is allowed from 'validated' or 'failed' states
  const allowedStates: SessionStatus[] = ['validated', 'failed'];
  if (!allowedStates.includes(session.status)) {
    throw new InvalidStateTransitionError(
      sessionId,
      session.status,
      'running'
    );
  }

  const previousStatus = session.status as 'validated' | 'failed';

  // Reset validation attempts — human is giving a fresh chance
  await this.db.updateSession(sessionId, {
    validationAttempts: 0,
    lastValidationResult: null,
  });

  // Build rejection feedback
  const rejectionMessage = formatFeedback({
    type: 'human_rejection',
    feedback,
    task: session.task,
    previousStatus,
    attempt: 0,
    maxAttempts: session.maxValidationAttempts,
  });

  // Transition to running
  await this.transitionSession(sessionId, 'running');
  this.eventBus.emit({
    type: 'session.status_changed',
    timestamp: new Date().toISOString(),
    sessionId,
    previousStatus,
    newStatus: 'running',
  });

  // Resume agent with rejection feedback
  const runtime = this.runtimeRegistry.get(session.runtime);
  const events = runtime.resume(sessionId, rejectionMessage);
  this.consumeAgentEvents(sessionId, events);

  this.logger.info({
    component: 'session-manager',
    sessionId,
    msg: `Session rejected from ${previousStatus} state, resuming agent with feedback`,
  });
}
```

### File Summary

| File | Purpose |
|------|---------|
| `packages/daemon/src/sessions/feedback-formatter.ts` | Builds structured feedback messages for each failure type |
| `packages/daemon/src/sessions/correction-context.ts` | Gathers diff, screenshots, instructions for correction context |
| `packages/daemon/src/sessions/session-manager.ts` | Enhanced `handleValidationFailure()` and `rejectSession()` |

### Testing

```typescript
// feedback-formatter.test.ts
describe('FeedbackFormatter', () => {
  it('should format build failure with build output', () => {
    const result = formatFeedback({
      type: 'validation_failure',
      result: mockValidationResult({ buildFailed: true }),
      task: 'Add a contact page',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(result).toContain('Build Errors');
    expect(result).toContain('attempt 1/3');
  });

  it('should format health check failure', () => {
    const result = formatFeedback({
      type: 'validation_failure',
      result: mockValidationResult({ healthFailed: true }),
      task: 'Fix the homepage',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(result).toContain('Health Check Failed');
  });

  it('should format human rejection from validated state', () => {
    const result = formatFeedback({
      type: 'human_rejection',
      feedback: 'Button color should be blue, not red',
      task: 'Redesign the CTA button',
      previousStatus: 'validated',
      attempt: 0,
      maxAttempts: 3,
    });
    expect(result).toContain('passed validation but the reviewer wants changes');
    expect(result).toContain('Button color should be blue');
  });

  it('should format human rejection from failed state', () => {
    const result = formatFeedback({
      type: 'human_rejection',
      feedback: 'Try a different approach',
      task: 'Fix the build',
      previousStatus: 'failed',
      attempt: 0,
      maxAttempts: 3,
    });
    expect(result).toContain('another chance');
  });

  it('should format escalation response', () => {
    const result = formatFeedback({
      type: 'escalation_response',
      question: 'What color should the header be?',
      response: {
        respondedAt: new Date().toISOString(),
        respondedBy: 'human',
        response: 'Use brand blue (#1a73e8)',
      },
    });
    expect(result).toContain('#1a73e8');
  });

  it('should include task review issues when present', () => {
    const result = formatFeedback({
      type: 'validation_failure',
      result: mockValidationResult({
        taskReviewFailed: true,
        issues: ['Missing footer', 'Wrong font'],
      }),
      task: 'Rebuild the landing page',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(result).toContain('Missing footer');
    expect(result).toContain('Wrong font');
  });
});

// correction-context.test.ts
describe('CorrectionContextBuilder', () => {
  it('should determine build as failed step when build fails', () => {
    const step = determineFailedStep(mockResult({ buildFailed: true }));
    expect(step).toBe('build');
  });

  it('should determine health as failed step when health fails', () => {
    const step = determineFailedStep(mockResult({ healthFailed: true }));
    expect(step).toBe('health');
  });

  it('should truncate long diffs', () => {
    const longDiff = 'a'.repeat(100_000);
    const truncated = truncateDiff(longDiff, 50_000);
    expect(truncated.length).toBeLessThanOrEqual(50_020); // + "...(truncated)"
    expect(truncated).toContain('truncated');
  });

  it('should include previous diff in correction context', async () => {
    const mockContainerManager = {
      execInContainer: vi.fn().mockResolvedValue('+added line\n-removed line'),
    };
    const context = await buildCorrectionContext(
      mockSession, mockProfile, mockResult(), mockContainerManager as any
    );
    expect(context.previousDiff).toContain('+added line');
  });
});

// session-manager.test.ts (correction-specific tests)
describe('SessionManager correction flow', () => {
  it('should retry on validation failure when retries remain', async () => {
    const session = createMockSession({ validationAttempts: 0, maxValidationAttempts: 3 });
    await manager.handleValidationFailure(session, mockFailedResult());
    expect(runtime.resume).toHaveBeenCalled();
    expect(db.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({
      validationAttempts: 1,
    }));
  });

  it('should transition to failed when retries exhausted', async () => {
    const session = createMockSession({ validationAttempts: 2, maxValidationAttempts: 3 });
    await manager.handleValidationFailure(session, mockFailedResult());
    expect(manager.transitionSession).toHaveBeenCalledWith(session.id, 'failed');
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalled();
  });

  it('should reset attempts on human rejection', async () => {
    const session = createMockSession({ status: 'validated', validationAttempts: 2 });
    await manager.rejectSession(session.id, 'Needs more work');
    expect(db.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({
      validationAttempts: 0,
    }));
    expect(runtime.resume).toHaveBeenCalled();
  });

  it('should reject from failed state', async () => {
    const session = createMockSession({ status: 'failed', validationAttempts: 3 });
    await manager.rejectSession(session.id, 'Try a different approach');
    expect(manager.transitionSession).toHaveBeenCalledWith(session.id, 'running');
  });

  it('should throw on reject from invalid state', async () => {
    const session = createMockSession({ status: 'running' });
    await expect(manager.rejectSession(session.id, 'nope'))
      .rejects.toThrow(InvalidStateTransitionError);
  });
});
```

### Integration Test

```typescript
// e2e/correction-flow.test.ts
describe('Correction Flow E2E', () => {
  it('should handle full correction cycle: create → validate → fail → retry → succeed', async () => {
    // 1. Create session
    const session = await api.post('/api/sessions', {
      profileName: 'test-app',
      task: 'Add a contact page',
    });
    expect(session.status).toBe('queued');

    // 2. Wait for agent to complete (mock agent writes broken code)
    await waitForStatus(session.id, 'validating');

    // 3. Validation should fail (broken code)
    await waitForStatus(session.id, 'running'); // auto-retry

    // 4. Verify agent received feedback
    const events = await api.get(`/api/sessions/${session.id}/events`);
    const resumeEvent = events.find(e =>
      e.type === 'session.agent_activity' &&
      e.event.type === 'status' &&
      e.event.message.includes('Validation Failed')
    );
    expect(resumeEvent).toBeDefined();

    // 5. Agent fixes code, validation passes
    await waitForStatus(session.id, 'validated');

    // 6. Verify attempt count
    const updatedSession = await api.get(`/api/sessions/${session.id}`);
    expect(updatedSession.validationAttempts).toBe(2);
  });
});
```

### Acceptance Criteria

- [ ] Validation failures produce clear, actionable feedback for the agent with specific errors
- [ ] Human rejections include the reviewer's feedback in structured format
- [ ] Retry count is tracked in the database and enforced against `maxValidationAttempts`
- [ ] Agent receives full correction context: original task, what failed, previous diff, project instructions
- [ ] After max retries exhausted, session transitions to `failed` and human is notified
- [ ] Human can reject a `validated` session and agent retries with reset attempt budget
- [ ] Human can reject a `failed` session to give the agent another chance
- [ ] Rejection from any state other than `validated` or `failed` throws `InvalidStateTransitionError`
- [ ] Escalation responses are formatted and delivered to the agent via `Runtime.resume()`
- [ ] Long diffs are truncated to `MAX_DIFF_LENGTH` to avoid overloading the agent's context

---

## Milestone M13: Codex Runtime

**Location**: `packages/daemon/src/runtimes/`
**Depends on**: M3 (Runtime Adapters — follows the same interface pattern as the Claude adapter)

The second runtime adapter. This lets Autopod orchestrate OpenAI's Codex CLI with the exact same session lifecycle as Claude. Same `Runtime` interface, same `AgentEvent` types — the session manager doesn't know or care which agent is working.

### Component 1: CodexRuntime

**File**: `packages/daemon/src/runtimes/codex-runtime.ts`

Implements the `Runtime` interface from `@autopod/shared` for the Codex CLI.

```typescript
import type { Runtime, SpawnConfig, AgentEvent } from '@autopod/shared';
import { CodexStreamParser } from './codex-stream-parser';
import { RuntimeError } from '@autopod/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger';

export class CodexRuntime implements Runtime {
  readonly type = 'codex' as const;

  private processes = new Map<string, ChildProcess>();

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'codex-runtime',
      sessionId: config.sessionId,
      msg: `Spawning codex: codex ${args.join(' ')}`,
    });

    const proc = spawn('codex', args, {
      cwd: config.workDir,
      env: {
        ...process.env,
        ...config.env,
        // Codex CLI uses OPENAI_API_KEY from env
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(config.sessionId, proc);

    try {
      yield* CodexStreamParser.parse(proc.stdout!, config.sessionId);
    } finally {
      this.processes.delete(config.sessionId);
    }

    // Check exit code
    const exitCode = await this.waitForExit(proc);
    if (exitCode !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Codex process exited with code ${exitCode}`,
        fatal: true,
      };
    }
  }

  async *resume(sessionId: string, message: string): AsyncIterable<AgentEvent> {
    // Codex CLI resume: pass the message as a follow-up task
    // The --resume flag continues an existing session
    const args = [
      'exec',
      message,
      '--full-auto',
      '--json',
    ];

    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(sessionId, proc);

    try {
      yield* CodexStreamParser.parse(proc.stdout!, sessionId);
    } finally {
      this.processes.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (!proc) {
      this.logger.warn({
        component: 'codex-runtime',
        sessionId,
        msg: 'No process found to abort',
      });
      return;
    }

    // Graceful shutdown: SIGTERM first, SIGKILL after timeout
    proc.kill('SIGTERM');

    const killTimeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
        this.logger.warn({
          component: 'codex-runtime',
          sessionId,
          msg: 'Codex process did not exit after SIGTERM, sent SIGKILL',
        });
      }
    }, 5_000);

    await this.waitForExit(proc);
    clearTimeout(killTimeout);
    this.processes.delete(sessionId);
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = [
      'exec',
      config.task,
      '--model', config.model,
      '--full-auto',
      '--json',
    ];

    // Custom instructions: write to .codex/instructions.md in the workdir
    // (handled before spawn by the session manager)

    return args;
  }

  private waitForExit(proc: ChildProcess): Promise<number> {
    return new Promise((resolve) => {
      proc.on('exit', (code) => resolve(code ?? 1));
    });
  }
}
```

### Component 2: Codex Stream Parser

**File**: `packages/daemon/src/runtimes/codex-stream-parser.ts`

Parses the JSONL output from `codex exec --json` into normalized `AgentEvent` types. The Codex CLI emits one JSON object per line.

```typescript
import type { AgentEvent } from '@autopod/shared';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { logger } from '../logger';

// TODO: Verify these event types against actual Codex CLI output.
// The Codex JSONL format may differ from what's documented here.
// This is a best-effort mapping based on available documentation.

interface CodexEvent {
  type: string;
  // Common fields
  timestamp?: string;
  // Type-specific fields vary
  [key: string]: unknown;
}

export class CodexStreamParser {
  /**
   * Parse a JSONL stream from codex exec --json into AgentEvents.
   *
   * Each line is a JSON object. We read line-by-line to handle
   * partial output and errors gracefully.
   */
  static async *parse(
    stream: Readable,
    sessionId: string
  ): AsyncIterable<AgentEvent> {
    const rl = createInterface({ input: stream });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        logger.warn({
          component: 'codex-stream-parser',
          sessionId,
          msg: `Failed to parse JSONL line: ${trimmed.slice(0, 200)}`,
        });
        continue;
      }

      const mapped = CodexStreamParser.mapEvent(event, sessionId);
      if (mapped) yield mapped;
    }
  }

  /**
   * Map a Codex event to an AgentEvent.
   *
   * Codex CLI event types (best-effort mapping):
   * - "task_start"       → AgentStatusEvent
   * - "file_read"        → AgentToolUseEvent
   * - "file_write"       → AgentFileChangeEvent + AgentToolUseEvent
   * - "file_delete"      → AgentFileChangeEvent
   * - "command_run"      → AgentToolUseEvent
   * - "command_output"   → AgentToolUseEvent
   * - "message"          → AgentStatusEvent
   * - "task_complete"    → AgentCompleteEvent
   * - "error"            → AgentErrorEvent
   */
  static mapEvent(event: CodexEvent, sessionId: string): AgentEvent | null {
    const ts = event.timestamp ?? new Date().toISOString();

    switch (event.type) {
      case 'task_start':
        return {
          type: 'status',
          timestamp: ts,
          message: (event.message as string) ?? 'Codex agent started',
        };

      case 'file_read':
        return {
          type: 'tool_use',
          timestamp: ts,
          tool: 'Read',
          input: { path: event.path },
          output: (event.content as string)?.slice(0, 500),
        };

      case 'file_write':
        // Emit both a tool_use and a file_change event
        // The caller should handle this by yielding the file_change
        // We return the file_change here; tool_use is secondary
        return {
          type: 'file_change',
          timestamp: ts,
          path: event.path as string,
          action: (event.existed as boolean) ? 'modify' : 'create',
          diff: event.diff as string | undefined,
        };

      case 'file_delete':
        return {
          type: 'file_change',
          timestamp: ts,
          path: event.path as string,
          action: 'delete',
        };

      case 'command_run':
        return {
          type: 'tool_use',
          timestamp: ts,
          tool: 'Bash',
          input: { command: event.command },
        };

      case 'command_output':
        return {
          type: 'tool_use',
          timestamp: ts,
          tool: 'Bash',
          input: { command: event.command },
          output: (event.output as string)?.slice(0, 2000),
        };

      case 'message':
        return {
          type: 'status',
          timestamp: ts,
          message: event.message as string,
        };

      case 'task_complete':
        return {
          type: 'complete',
          timestamp: ts,
          result: (event.result as string) ?? 'Codex agent completed',
        };

      case 'error':
        return {
          type: 'error',
          timestamp: ts,
          message: (event.message as string) ?? 'Unknown Codex error',
          fatal: (event.fatal as boolean) ?? false,
        };

      default:
        logger.debug({
          component: 'codex-stream-parser',
          sessionId,
          msg: `Unknown Codex event type: ${event.type}`,
        });
        return null;
    }
  }
}
```

### Component 3: Runtime Registry Update

**File**: Update `packages/daemon/src/runtimes/runtime-registry.ts`

```typescript
import { ClaudeRuntime } from './claude-runtime';
import { CodexRuntime } from './codex-runtime';
import type { Runtime, RuntimeType } from '@autopod/shared';

export class RuntimeRegistry {
  private runtimes = new Map<RuntimeType, Runtime>();

  constructor() {
    this.register(new ClaudeRuntime());
    this.register(new CodexRuntime());
  }

  register(runtime: Runtime): void {
    this.runtimes.set(runtime.type, runtime);
  }

  get(type: RuntimeType): Runtime {
    const runtime = this.runtimes.get(type);
    if (!runtime) {
      throw new RuntimeError(`No runtime registered for type: ${type}`, type);
    }
    return runtime;
  }

  list(): RuntimeType[] {
    return [...this.runtimes.keys()];
  }
}
```

### Model Mapping

Codex CLI uses OpenAI model names directly. No translation needed — the model string from the profile or session is passed straight to `--model`:

```typescript
// Example model values for codex runtime:
// - "gpt-5.2"
// - "o3-mini"
// - "o4-mini"
//
// The daemon doesn't validate model names against a list.
// If the model doesn't exist, Codex CLI will error and the
// session will get an AgentErrorEvent with fatal: true.
```

### File Summary

| File | Purpose |
|------|---------|
| `packages/daemon/src/runtimes/codex-runtime.ts` | `Runtime` implementation for Codex CLI |
| `packages/daemon/src/runtimes/codex-stream-parser.ts` | JSONL parser mapping Codex events to AgentEvents |
| `packages/daemon/src/runtimes/runtime-registry.ts` | Updated to register CodexRuntime |

### Testing

```typescript
// codex-stream-parser.test.ts
describe('CodexStreamParser', () => {
  it('should parse task_start event', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'task_start', message: 'Starting task' },
      'test-id'
    );
    expect(event).toEqual({
      type: 'status',
      timestamp: expect.any(String),
      message: 'Starting task',
    });
  });

  it('should parse file_write as file_change event', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'file_write', path: 'src/index.ts', existed: true, diff: '+new line' },
      'test-id'
    );
    expect(event).toEqual({
      type: 'file_change',
      timestamp: expect.any(String),
      path: 'src/index.ts',
      action: 'modify',
      diff: '+new line',
    });
  });

  it('should parse file_write for new file as create', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'file_write', path: 'new-file.ts', existed: false },
      'test-id'
    );
    expect(event?.type).toBe('file_change');
    expect((event as any).action).toBe('create');
  });

  it('should parse command_run as tool_use', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'command_run', command: 'npm test' },
      'test-id'
    );
    expect(event).toEqual({
      type: 'tool_use',
      timestamp: expect.any(String),
      tool: 'Bash',
      input: { command: 'npm test' },
    });
  });

  it('should parse task_complete event', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'task_complete', result: 'All done' },
      'test-id'
    );
    expect(event).toEqual({
      type: 'complete',
      timestamp: expect.any(String),
      result: 'All done',
    });
  });

  it('should parse error event', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'error', message: 'Rate limited', fatal: true },
      'test-id'
    );
    expect(event).toEqual({
      type: 'error',
      timestamp: expect.any(String),
      message: 'Rate limited',
      fatal: true,
    });
  });

  it('should return null for unknown event types', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'unknown_thing', data: 'whatever' },
      'test-id'
    );
    expect(event).toBeNull();
  });

  it('should handle malformed JSONL lines gracefully', async () => {
    const stream = createMockStream([
      '{"type":"task_start","message":"hi"}',
      'not json at all',
      '{"type":"task_complete","result":"done"}',
    ]);
    const events: AgentEvent[] = [];
    for await (const event of CodexStreamParser.parse(stream, 'test-id')) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('status');
    expect(events[1].type).toBe('complete');
  });

  it('should truncate long file read content', () => {
    const event = CodexStreamParser.mapEvent(
      { type: 'file_read', path: 'big.ts', content: 'x'.repeat(10_000) },
      'test-id'
    );
    expect(event?.type).toBe('tool_use');
    expect((event as any).output.length).toBeLessThanOrEqual(500);
  });
});

// codex-runtime.test.ts
describe('CodexRuntime', () => {
  it('should build correct spawn args', () => {
    const runtime = new CodexRuntime();
    const args = (runtime as any).buildSpawnArgs({
      sessionId: 'abc123',
      task: 'Fix the bug',
      model: 'o3-mini',
      workDir: '/workspace',
      env: {},
    });
    expect(args).toEqual([
      'exec', 'Fix the bug',
      '--model', 'o3-mini',
      '--full-auto', '--json',
    ]);
  });

  it('should track processes for abort', async () => {
    const runtime = new CodexRuntime();
    // Mock spawn to return a controllable process
    const mockProc = createMockProcess();
    vi.spyOn(cp, 'spawn').mockReturnValue(mockProc as any);

    // Start consuming (don't await — it's async)
    const iterator = runtime.spawn(mockConfig)[Symbol.asyncIterator]();

    // Process should be tracked
    expect((runtime as any).processes.has('test-session')).toBe(true);

    // Abort
    await runtime.abort('test-session');
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should SIGKILL after timeout if SIGTERM ignored', async () => {
    vi.useFakeTimers();
    const runtime = new CodexRuntime();
    const mockProc = createMockProcess({ ignoreSignals: true });
    (runtime as any).processes.set('test-session', mockProc);

    const abortPromise = runtime.abort('test-session');

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(5_000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });
});

// runtime-registry.test.ts
describe('RuntimeRegistry', () => {
  it('should return ClaudeRuntime for "claude"', () => {
    const registry = new RuntimeRegistry();
    const runtime = registry.get('claude');
    expect(runtime.type).toBe('claude');
  });

  it('should return CodexRuntime for "codex"', () => {
    const registry = new RuntimeRegistry();
    const runtime = registry.get('codex');
    expect(runtime.type).toBe('codex');
  });

  it('should throw for unknown runtime type', () => {
    const registry = new RuntimeRegistry();
    expect(() => registry.get('unknown' as any)).toThrow(RuntimeError);
  });

  it('should list all registered runtimes', () => {
    const registry = new RuntimeRegistry();
    expect(registry.list()).toEqual(expect.arrayContaining(['claude', 'codex']));
  });
});
```

### Acceptance Criteria

- [ ] `CodexRuntime` implements the `Runtime` interface (`spawn`, `resume`, `abort`)
- [ ] `CodexStreamParser` handles Codex JSONL output and maps all known event types
- [ ] Unknown event types are logged and skipped (not fatal)
- [ ] Malformed JSONL lines are logged and skipped (not fatal)
- [ ] `RuntimeRegistry` returns `CodexRuntime` for `RuntimeType "codex"`
- [ ] `spawn()` builds correct `codex exec` command with `--model`, `--full-auto`, `--json`
- [ ] `abort()` sends SIGTERM, then SIGKILL after 5s timeout
- [ ] `AgentEvent` output from Codex is indistinguishable from Claude output (same types, same fields)
- [ ] Process lifecycle is tracked — no orphaned Codex processes after abort

---

## Milestone M14: Image Warming

**Location**: `packages/daemon/src/images/`
**Depends on**: M2 (Container Engine), M5 (Profile System)

Pre-baked Docker images per profile with dependencies already installed. Instead of running `npm ci` every time a session starts (60–120s), we clone + install once into a warm image and reuse it. Session startup drops from minutes to seconds.

### Architecture

```mermaid
flowchart LR
    subgraph Build Time
        P[Profile Config] --> DG[Dockerfile Generator]
        DG --> DF[Generated Dockerfile]
        DF --> IB[Image Builder]
        IB --> ACR[Azure Container Registry]
    end

    subgraph Session Start
        ACR --> CM[Container Manager]
        CM --> |warm image exists| FAST[Fast Start<br/>~10s]
        CM --> |no warm image| SLOW[Cold Start<br/>~120s]
    end

    style FAST fill:#d5f5d5,stroke:#333
    style SLOW fill:#f5d5d5,stroke:#333
```

### Component 1: Dockerfile Generator

**File**: `packages/daemon/src/images/dockerfile-generator.ts`

Generates profile-specific Dockerfiles from profile configuration. Each profile's warm image is built on top of a base template image.

```typescript
import type { Profile, StackTemplate } from '@autopod/shared';

interface DockerfileOptions {
  profile: Profile;
  gitCredentials: 'pat' | 'ssh' | 'none';
}

export function generateDockerfile(options: DockerfileOptions): string {
  const { profile } = options;
  const baseImage = getBaseImage(profile.template);
  const installCommand = getInstallCommand(profile);

  const lines: string[] = [
    `FROM ${baseImage}`,
    '',
    '# Clone repo and install dependencies',
    'WORKDIR /workspace',
  ];

  // Git credentials for private repos
  if (options.gitCredentials === 'pat') {
    lines.push(
      'ARG GIT_PAT',
      `RUN git clone --depth 1 https://x-access-token:\${GIT_PAT}@${stripProtocol(profile.repoUrl)} .`
    );
  } else {
    lines.push(
      `RUN git clone --depth 1 ${profile.repoUrl} .`
    );
  }

  // Install dependencies
  lines.push('');
  lines.push('# Install dependencies');
  lines.push(`RUN ${installCommand}`);

  // Pre-warm build caches
  lines.push('');
  lines.push('# Pre-warm: run build to populate caches');
  lines.push('# || true because build may fail without code changes — we just want cached deps');
  lines.push(`RUN ${profile.buildCommand} || true`);

  // Clean up git credentials
  if (options.gitCredentials === 'pat') {
    lines.push('');
    lines.push('# Remove git credentials from image');
    lines.push('RUN git remote set-url origin https://github.com/placeholder/repo.git');
  }

  // Set non-root user
  lines.push('');
  lines.push('USER autopod');

  return lines.join('\n');
}

function getBaseImage(template: StackTemplate): string {
  const imageMap: Record<StackTemplate, string> = {
    'node22': 'autopod-node22:latest',
    'node22-pw': 'autopod-node22-pw:latest',
    'dotnet9': 'autopod-dotnet9:latest',
    'python312': 'autopod-python312:latest',
    'custom': 'autopod-node22:latest', // fallback
  };
  return imageMap[template];
}

function getInstallCommand(profile: Profile): string {
  // Infer package manager from build command
  if (profile.buildCommand.includes('pnpm')) {
    return 'corepack enable pnpm && pnpm install --frozen-lockfile';
  }
  if (profile.buildCommand.includes('yarn')) {
    return 'corepack enable yarn && yarn install --frozen-lockfile';
  }
  if (profile.buildCommand.includes('dotnet')) {
    return 'dotnet restore';
  }
  if (profile.buildCommand.includes('pip')) {
    return 'pip install -r requirements.txt';
  }
  // Default: npm
  return 'npm ci';
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
```

#### Generated Dockerfile Example (Node.js project with pnpm)

```dockerfile
FROM autopod-node22-pw:latest

# Clone repo and install dependencies
WORKDIR /workspace
ARG GIT_PAT
RUN git clone --depth 1 https://x-access-token:${GIT_PAT}@github.com/esbenwiberg/ideaspace .

# Install dependencies
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Pre-warm: run build to populate caches
# || true because build may fail without code changes — we just want cached deps
RUN npm run build || true

# Remove git credentials from image
RUN git remote set-url origin https://github.com/placeholder/repo.git

USER autopod
```

### Component 2: Image Builder

**File**: `packages/daemon/src/images/image-builder.ts`

Orchestrates the full image build lifecycle: generate Dockerfile, build image, push to ACR, update profile.

```typescript
import type { Profile } from '@autopod/shared';
import { generateDockerfile } from './dockerfile-generator';
import type { AcrClient } from './acr-client';
import type { Docker } from 'dockerode';
import { logger } from '../logger';

interface ImageBuildResult {
  tag: string;
  digest: string;
  size: number;           // bytes
  buildDuration: number;  // seconds
}

export class ImageBuilder {
  constructor(
    private docker: Docker,
    private acr: AcrClient,
    private db: DatabaseClient,
  ) {}

  /**
   * Build a warm image for a profile and push it to ACR.
   */
  async buildWarmImage(
    profile: Profile,
    options: { rebuild?: boolean; gitPat?: string } = {}
  ): Promise<ImageBuildResult> {
    const tag = `autopod/${profile.name}:latest`;
    const timestampTag = `autopod/${profile.name}:${Date.now()}`;

    // Check if warm image exists and isn't stale
    if (!options.rebuild && profile.warmImageTag) {
      const age = this.getImageAge(profile.warmImageBuiltAt);
      if (age < this.staleThresholdMs) {
        logger.info({
          component: 'image-builder',
          msg: `Warm image for ${profile.name} is still fresh (${Math.floor(age / 86400000)}d old)`,
        });
        throw new Error(`Warm image for "${profile.name}" is still fresh. Use --rebuild to force.`);
      }
    }

    logger.info({
      component: 'image-builder',
      msg: `Building warm image for profile: ${profile.name}`,
    });

    const startTime = Date.now();

    // 1. Generate Dockerfile
    const dockerfile = generateDockerfile({
      profile,
      gitCredentials: options.gitPat ? 'pat' : 'none',
    });

    // 2. Build image using Docker API
    const buildStream = await this.docker.buildImage(
      {
        context: '/dev/null', // No build context — everything is in the Dockerfile
        src: [],
      },
      {
        dockerfile: undefined, // We'll pass the Dockerfile content via the stream
        t: tag,
        buildargs: options.gitPat ? { GIT_PAT: options.gitPat } : undefined,
        // Use the Dockerfile content directly
        // dockerode supports passing Dockerfile content via a tar stream
      }
    );

    // In practice: create a tar archive with the Dockerfile and pass it
    await this.buildFromDockerfile(dockerfile, tag, options.gitPat);

    const buildDuration = (Date.now() - startTime) / 1000;

    // 3. Tag with timestamp for rollback
    const image = this.docker.getImage(tag);
    await image.tag({ repo: timestampTag.split(':')[0], tag: timestampTag.split(':')[1] });

    // 4. Push to ACR
    logger.info({
      component: 'image-builder',
      msg: `Pushing ${tag} to ACR`,
    });
    const digest = await this.acr.push(tag);
    await this.acr.push(timestampTag); // Keep timestamped version too

    // 5. Get image size
    const inspectInfo = await image.inspect();
    const size = inspectInfo.Size ?? 0;

    // 6. Update profile in database
    await this.db.updateProfile(profile.name, {
      warmImageTag: tag,
      warmImageBuiltAt: new Date().toISOString(),
    });

    logger.info({
      component: 'image-builder',
      msg: `Warm image built: ${tag} (${Math.floor(size / 1_048_576)}MB, ${buildDuration.toFixed(1)}s)`,
    });

    return { tag, digest, size, buildDuration };
  }

  /**
   * Check if a profile's warm image is stale.
   */
  isStale(profile: Profile): boolean {
    if (!profile.warmImageBuiltAt) return true;
    return this.getImageAge(profile.warmImageBuiltAt) > this.staleThresholdMs;
  }

  private get staleThresholdMs(): number {
    // Default: 7 days. Could be made configurable per profile.
    return 7 * 24 * 60 * 60 * 1000;
  }

  private getImageAge(builtAt: string | null): number {
    if (!builtAt) return Infinity;
    return Date.now() - new Date(builtAt).getTime();
  }

  private async buildFromDockerfile(
    dockerfileContent: string,
    tag: string,
    gitPat?: string
  ): Promise<void> {
    // Create an in-memory tar archive containing just the Dockerfile
    const tar = await import('tar-stream');
    const pack = tar.pack();

    pack.entry({ name: 'Dockerfile' }, dockerfileContent);
    pack.finalize();

    const buildStream = await this.docker.buildImage(pack as any, {
      t: tag,
      buildargs: gitPat ? { GIT_PAT: gitPat } : undefined,
    });

    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        buildStream,
        (err: Error | null) => err ? reject(err) : resolve(),
        (event: any) => {
          if (event.stream) {
            logger.debug({
              component: 'image-builder',
              msg: event.stream.trim(),
            });
          }
          if (event.error) {
            reject(new Error(event.error));
          }
        }
      );
    });
  }
}
```

### Component 3: ACR Client

**File**: `packages/daemon/src/images/acr-client.ts`

Thin wrapper around Azure Container Registry operations. Uses the daemon's Managed Identity for authentication (no stored credentials).

```typescript
import { DefaultAzureCredential } from '@azure/identity';
import { ContainerRegistryClient } from '@azure/container-registry';
import type { Docker } from 'dockerode';
import { logger } from '../logger';

interface AcrConfig {
  registryUrl: string;     // e.g., "myregistry.azurecr.io"
  resourceGroup: string;
}

export class AcrClient {
  private registryClient: ContainerRegistryClient;
  private credential: DefaultAzureCredential;

  constructor(
    private config: AcrConfig,
    private docker: Docker,
  ) {
    this.credential = new DefaultAzureCredential();
    this.registryClient = new ContainerRegistryClient(
      `https://${config.registryUrl}`,
      this.credential
    );
  }

  /**
   * Push a local Docker image to ACR.
   * Returns the image digest.
   */
  async push(tag: string): Promise<string> {
    // 1. Get ACR access token via Managed Identity
    const token = await this.getAccessToken();

    // 2. Login to ACR via Docker
    await this.dockerLogin(token);

    // 3. Tag image for ACR
    const acrTag = `${this.config.registryUrl}/${tag}`;
    const image = this.docker.getImage(tag);
    await image.tag({
      repo: `${this.config.registryUrl}/${tag.split(':')[0]}`,
      tag: tag.split(':')[1] || 'latest',
    });

    // 4. Push
    const acrImage = this.docker.getImage(acrTag);
    const pushStream = await acrImage.push({ authconfig: { serveraddress: this.config.registryUrl } });

    const digest = await new Promise<string>((resolve, reject) => {
      let lastDigest = '';
      this.docker.modem.followProgress(
        pushStream,
        (err: Error | null) => err ? reject(err) : resolve(lastDigest),
        (event: any) => {
          if (event.aux?.Digest) {
            lastDigest = event.aux.Digest;
          }
          if (event.error) {
            reject(new Error(event.error));
          }
        }
      );
    });

    logger.info({
      component: 'acr-client',
      msg: `Pushed ${acrTag} (digest: ${digest})`,
    });

    return digest;
  }

  /**
   * Pull an image from ACR.
   */
  async pull(tag: string): Promise<void> {
    const token = await this.getAccessToken();
    await this.dockerLogin(token);

    const acrTag = `${this.config.registryUrl}/${tag}`;

    const pullStream = await this.docker.pull(acrTag, {
      authconfig: { serveraddress: this.config.registryUrl },
    });

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        pullStream,
        (err: Error | null) => err ? reject(err) : resolve(),
      );
    });
  }

  /**
   * Check if an image exists in ACR.
   */
  async exists(tag: string): Promise<boolean> {
    try {
      const [repo, version] = tag.split(':');
      const artifact = this.registryClient.getArtifact(repo, version || 'latest');
      await artifact.getManifestProperties();
      return true;
    } catch {
      return false;
    }
  }

  private async getAccessToken(): Promise<string> {
    const tokenResponse = await this.credential.getToken(
      `https://${this.config.registryUrl}/.default`
    );
    return tokenResponse.token;
  }

  private async dockerLogin(token: string): Promise<void> {
    // Use the token to authenticate with Docker daemon
    // This is equivalent to: docker login <registry> -u 00000000-0000-0000-0000-000000000000 -p <token>
    await this.docker.checkAuth({
      username: '00000000-0000-0000-0000-000000000000',
      password: token,
      serveraddress: this.config.registryUrl,
    });
  }
}
```

### Component 4: Container Manager Updates

**File**: Updates to `packages/daemon/src/containers/container-manager.ts`

The container manager checks for warm images when spawning sessions.

```typescript
// In container-manager.ts — update the spawn method

async function spawnContainer(
  session: Session,
  profile: Profile
): Promise<string> {
  let image: string;
  let needsDependencyInstall: boolean;

  if (profile.warmImageTag && !this.imageBuilder.isStale(profile)) {
    // Use warm image — deps are already installed
    image = `${this.acrConfig.registryUrl}/${profile.warmImageTag}`;
    needsDependencyInstall = false;

    // Pull latest version from ACR
    await this.acr.pull(profile.warmImageTag);

    this.logger.info({
      component: 'container-manager',
      sessionId: session.id,
      msg: `Using warm image: ${profile.warmImageTag}`,
    });
  } else {
    // Use base template — cold start, need to install deps
    image = getBaseImage(profile.template);
    needsDependencyInstall = true;

    if (profile.warmImageTag && this.imageBuilder.isStale(profile)) {
      this.logger.warn({
        component: 'container-manager',
        sessionId: session.id,
        msg: `Warm image for ${profile.name} is stale (built at ${profile.warmImageBuiltAt}). Using base image. Run "ap profile warm ${profile.name}" to rebuild.`,
      });
    }
  }

  // Create container
  const container = await this.docker.createContainer({
    Image: image,
    Cmd: ['sleep', 'infinity'], // Keep alive — agent process runs inside
    WorkingDir: '/workspace',
    // ... other container config
  });

  await container.start();
  const containerId = container.id;

  if (needsDependencyInstall) {
    // Cold start: clone repo and install deps inside the container
    await this.execInContainer(containerId, [
      'sh', '-c',
      `git clone --depth 1 ${profile.repoUrl} /workspace && cd /workspace && ${profile.buildCommand}`
    ]);
  } else {
    // Warm start: just create a fresh worktree with latest code
    await this.execInContainer(containerId, [
      'sh', '-c',
      `cd /workspace && git fetch origin ${profile.defaultBranch} && git reset --hard origin/${profile.defaultBranch}`
    ]);
  }

  // Create worktree for this session's branch
  const worktreePath = `/workspace/worktrees/${session.branch}`;
  await this.execInContainer(containerId, [
    'git', 'worktree', 'add', worktreePath, '-b', session.branch
  ], { cwd: '/workspace' });

  return containerId;
}
```

### CLI Integration

The `ap profile warm` command triggers image building:

```
ap profile warm <name>            # Build warm image for profile
ap profile warm <name> --rebuild  # Force rebuild even if not stale
ap profile warm --all             # Build warm images for all profiles
```

### File Summary

| File | Purpose |
|------|---------|
| `packages/daemon/src/images/dockerfile-generator.ts` | Generates profile-specific Dockerfiles |
| `packages/daemon/src/images/image-builder.ts` | Orchestrates image builds and pushes to ACR |
| `packages/daemon/src/images/acr-client.ts` | Azure Container Registry push/pull/auth |
| `packages/daemon/src/containers/container-manager.ts` | Updated to prefer warm images when spawning |

### Testing

```typescript
// dockerfile-generator.test.ts
describe('DockerfileGenerator', () => {
  it('should generate Dockerfile for node22-pw template', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'node22-pw', buildCommand: 'npm run build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-node22-pw:latest');
    expect(df).toContain('npm ci');
    expect(df).toContain('npm run build || true');
    expect(df).toContain('USER autopod');
  });

  it('should generate Dockerfile for pnpm project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ buildCommand: 'pnpm run build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('corepack enable pnpm');
    expect(df).toContain('pnpm install --frozen-lockfile');
  });

  it('should generate Dockerfile for dotnet project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'dotnet9', buildCommand: 'dotnet build' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-dotnet9:latest');
    expect(df).toContain('dotnet restore');
  });

  it('should include PAT-based git clone for private repos', () => {
    const df = generateDockerfile({
      profile: mockProfile({ repoUrl: 'https://github.com/private/repo' }),
      gitCredentials: 'pat',
    });
    expect(df).toContain('ARG GIT_PAT');
    expect(df).toContain('x-access-token:${GIT_PAT}@');
    // Should clean up credentials
    expect(df).toContain('git remote set-url origin');
  });

  it('should not include PAT args for public repos', () => {
    const df = generateDockerfile({
      profile: mockProfile(),
      gitCredentials: 'none',
    });
    expect(df).not.toContain('ARG GIT_PAT');
    expect(df).not.toContain('x-access-token');
  });

  it('should generate Dockerfile for python project', () => {
    const df = generateDockerfile({
      profile: mockProfile({ template: 'python312', buildCommand: 'pip install -e .' }),
      gitCredentials: 'none',
    });
    expect(df).toContain('FROM autopod-python312:latest');
    expect(df).toContain('pip install -r requirements.txt');
  });
});

// image-builder.test.ts
describe('ImageBuilder', () => {
  it('should build and push warm image', async () => {
    const builder = new ImageBuilder(mockDocker, mockAcr, mockDb);
    const result = await builder.buildWarmImage(mockProfile());

    expect(result.tag).toBe('autopod/test-app:latest');
    expect(mockAcr.push).toHaveBeenCalledTimes(2); // latest + timestamped
    expect(mockDb.updateProfile).toHaveBeenCalledWith('test-app', {
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: expect.any(String),
    });
  });

  it('should refuse to build if image is fresh and no --rebuild', async () => {
    const builder = new ImageBuilder(mockDocker, mockAcr, mockDb);
    const freshProfile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date().toISOString(), // just now
    });

    await expect(builder.buildWarmImage(freshProfile))
      .rejects.toThrow('still fresh');
  });

  it('should force build with rebuild option', async () => {
    const builder = new ImageBuilder(mockDocker, mockAcr, mockDb);
    const freshProfile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date().toISOString(),
    });

    const result = await builder.buildWarmImage(freshProfile, { rebuild: true });
    expect(result.tag).toBeDefined();
  });

  it('should detect stale images', () => {
    const builder = new ImageBuilder(mockDocker, mockAcr, mockDb);

    expect(builder.isStale(mockProfile({ warmImageBuiltAt: null }))).toBe(true);
    expect(builder.isStale(mockProfile({
      warmImageBuiltAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    }))).toBe(true);
    expect(builder.isStale(mockProfile({
      warmImageBuiltAt: new Date().toISOString()
    }))).toBe(false);
  });
});

// container-manager.test.ts (warm image selection)
describe('ContainerManager warm image', () => {
  it('should use warm image when available and fresh', async () => {
    const manager = createContainerManager();
    const session = mockSession();
    const profile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date().toISOString(),
    });

    await manager.spawnContainer(session, profile);

    expect(mockAcr.pull).toHaveBeenCalledWith('autopod/test-app:latest');
    // Should NOT run npm ci — deps are in the image
    expect(mockExec).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['npm', 'ci']),
      expect.anything()
    );
  });

  it('should fall back to base image when no warm image', async () => {
    const manager = createContainerManager();
    const session = mockSession();
    const profile = mockProfile({ warmImageTag: null });

    await manager.spawnContainer(session, profile);

    expect(mockAcr.pull).not.toHaveBeenCalled();
    // Should install deps from scratch
    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ Image: 'autopod-node22:latest' })
    );
  });

  it('should warn and fall back when warm image is stale', async () => {
    const manager = createContainerManager();
    const session = mockSession();
    const profile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await manager.spawnContainer(session, profile);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('stale') })
    );
  });
});
```

### Acceptance Criteria

- [ ] `DockerfileGenerator` produces correct Dockerfiles for each `StackTemplate` (node22, node22-pw, dotnet9, python312)
- [ ] Package manager is correctly inferred from `buildCommand` (npm, pnpm, yarn, pip, dotnet)
- [ ] Private repos use PAT-based clone with credential cleanup
- [ ] `ImageBuilder` orchestrates: generate Dockerfile → build image → push to ACR → update profile
- [ ] Both `:latest` and timestamped tags are pushed (for rollback)
- [ ] `AcrClient` authenticates via Managed Identity (no stored credentials)
- [ ] Profile's `warmImageTag` and `warmImageBuiltAt` are updated after successful build
- [ ] `ContainerManager` prefers warm images when available and fresh
- [ ] Stale images (> 7 days) trigger a warning and fall back to base image
- [ ] `--rebuild` flag forces a fresh build regardless of staleness
- [ ] Warm start creates a fresh worktree with latest code (not a full clone)
- [ ] Cold start clones repo and installs deps inside the container

---

## Milestone M15: Azure Deployment

**Location**: `infra/`
**Depends on**: All previous milestones (this packages everything for production)

Infrastructure as Code using Azure Bicep. Deploys the daemon as a Container App, with ACR for images, Key Vault for secrets, and Managed Identity for zero-credential auth. This is the final milestone — it doesn't exist until everything else works.

### Architecture

```mermaid
flowchart TB
    GH[GitHub Actions] -->|push image| ACR[Azure Container Registry]
    GH -->|deploy| BICEP[Bicep Templates]
    BICEP --> RG[Resource Group]

    subgraph RG[Resource Group]
        CAE[Container Apps Environment]
        KV[Key Vault]
        MI[Managed Identity]
        LA[Log Analytics]

        CAE --> DAEMON[Daemon Container App]
        CAE --> JOBS[Session Pod Jobs]
        MI -->|read secrets| KV
        MI -->|pull images| ACR
        DAEMON -->|triggers| JOBS
        DAEMON -->|logs| LA
    end

    subgraph KV[Key Vault]
        S1[anthropic-api-key]
        S2[openai-api-key]
        S3[github-pat]
        S4[teams-webhook-url]
    end

    style DAEMON fill:#e8d5f5,stroke:#333
    style KV fill:#f5e6d5,stroke:#333
    style MI fill:#d5e8f5,stroke:#333
```

### Bicep Module Structure

```
infra/
├── main.bicep                   # Orchestrator
├── modules/
│   ├── container-apps.bicep     # Container Apps Environment + daemon app
│   ├── acr.bicep                # Azure Container Registry
│   ├── keyvault.bicep           # Key Vault + secrets
│   ├── identity.bicep           # User-assigned Managed Identity + role assignments
│   └── log-analytics.bicep      # Log Analytics workspace
├── parameters/
│   ├── dev.bicepparam           # Dev environment parameters
│   └── prod.bicepparam          # Production parameters
└── README.md                    # Manual steps (Entra app registration)
```

### Module 1: `main.bicep`

```bicep
targetScope = 'resourceGroup'

@description('Environment name')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region')
param location string = resourceGroup().location

@description('Container Registry name')
param acrName string

@description('Daemon image tag')
param daemonImageTag string = 'latest'

// ─── Log Analytics ─────────────────────────────────────────
module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    location: location
    environment: environment
  }
}

// ─── Managed Identity ──────────────────────────────────────
module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    environment: environment
  }
}

// ─── Container Registry ────────────────────────────────────
module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    location: location
    acrName: acrName
    principalId: identity.outputs.principalId
  }
}

// ─── Key Vault ─────────────────────────────────────────────
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    environment: environment
    principalId: identity.outputs.principalId
  }
}

// ─── Container Apps ────────────────────────────────────────
module containerApps 'modules/container-apps.bicep' = {
  name: 'container-apps'
  params: {
    location: location
    environment: environment
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    logAnalyticsSharedKey: logAnalytics.outputs.sharedKey
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    acrLoginServer: acr.outputs.loginServer
    keyVaultUri: keyVault.outputs.vaultUri
    daemonImageTag: daemonImageTag
  }
}

// ─── Outputs ───────────────────────────────────────────────
output daemonFqdn string = containerApps.outputs.daemonFqdn
output acrLoginServer string = acr.outputs.loginServer
output keyVaultName string = keyVault.outputs.vaultName
```

### Module 2: `modules/container-apps.bicep`

```bicep
@description('Azure region')
param location string

@description('Environment name')
param environment string

@description('Log Analytics workspace ID')
param logAnalyticsWorkspaceId string

@description('Log Analytics shared key')
@secure()
param logAnalyticsSharedKey string

@description('User-assigned Managed Identity resource ID')
param identityId string

@description('Managed Identity client ID')
param identityClientId string

@description('ACR login server')
param acrLoginServer string

@description('Key Vault URI')
param keyVaultUri string

@description('Daemon image tag')
param daemonImageTag string

// ─── Container Apps Environment ────────────────────────────
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'autopod-${environment}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspaceId
        sharedKey: logAnalyticsSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ─── Azure File Share for SQLite DB ────────────────────────
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'autopod${environment}storage'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'autopod-data'
  properties: {
    shareQuota: 1 // 1 GB — SQLite DB won't be large
  }
}

// Mount the file share in the Container Apps Environment
resource caeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: cae
  name: 'autopod-data'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'autopod-data'
      accessMode: 'ReadWrite'
    }
  }
}

// ─── Daemon Container App ──────────────────────────────────
resource daemonApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'autopod-${environment}-daemon'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*']  // Tighten in production
        }
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/anthropic-api-key'
          identity: identityId
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/openai-api-key'
          identity: identityId
        }
        {
          name: 'github-pat'
          keyVaultUrl: '${keyVaultUri}secrets/github-pat'
          identity: identityId
        }
        {
          name: 'teams-webhook-url'
          keyVaultUrl: '${keyVaultUri}secrets/teams-webhook-url'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'daemon'
          image: '${acrLoginServer}/autopod/daemon:${daemonImageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'DB_PATH', value: '/data/autopod.db' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'GITHUB_PAT', secretRef: 'github-pat' }
            { name: 'TEAMS_WEBHOOK_URL', secretRef: 'teams-webhook-url' }
          ]
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'startup'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 10
            }
            {
              type: 'liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'readiness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageName: 'autopod-data'
          storageType: 'AzureFile'
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [caeStorage]
}

output daemonFqdn string = daemonApp.properties.configuration.ingress.fqdn
```

### Module 3: `modules/acr.bicep`

```bicep
@description('Azure region')
param location string

@description('Container Registry name')
param acrName string

@description('Principal ID for AcrPull role assignment')
param principalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false  // Use Managed Identity, not admin user
    publicNetworkAccess: 'Enabled'
  }
}

// Grant AcrPull to the daemon's Managed Identity
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, principalId, 'acrpull')
  scope: acr
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull built-in role
    )
    principalType: 'ServicePrincipal'
  }
}

// Grant AcrPush for GitHub Actions (will use OIDC)
// This is assigned separately in the deploy workflow

output loginServer string = acr.properties.loginServer
output acrId string = acr.id
```

### Module 4: `modules/keyvault.bicep`

```bicep
@description('Azure region')
param location string

@description('Environment name')
param environment string

@description('Principal ID for secret read access')
param principalId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'autopod-${environment}-kv'
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enableRbacAuthorization: true  // Use RBAC instead of access policies
  }
}

// Grant Key Vault Secrets User to the daemon's Managed Identity
resource kvSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, principalId, 'kvsecretsuser')
  scope: keyVault
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
    )
    principalType: 'ServicePrincipal'
  }
}

// Secrets are created manually or via CLI — not in Bicep
// (Never put secret VALUES in IaC templates)
//
// az keyvault secret set --vault-name autopod-${env}-kv --name anthropic-api-key --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name openai-api-key --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name github-pat --value <value>
// az keyvault secret set --vault-name autopod-${env}-kv --name teams-webhook-url --value <value>

output vaultUri string = keyVault.properties.vaultUri
output vaultName string = keyVault.name
```

### Module 5: `modules/identity.bicep`

```bicep
@description('Azure region')
param location string

@description('Environment name')
param environment string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'autopod-${environment}-identity'
  location: location
}

output identityId string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
```

### Module 6: `modules/log-analytics.bicep`

```bicep
@description('Azure region')
param location string

@description('Environment name')
param environment string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'autopod-${environment}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

output workspaceId string = workspace.properties.customerId
output sharedKey string = workspace.listKeys().primarySharedKey
```

### Environment Parameters

**`infra/parameters/dev.bicepparam`**:

```bicep
using '../main.bicep'

param environment = 'dev'
param location = 'westeurope'
param acrName = 'autopoddevacr'
param daemonImageTag = 'latest'
```

**`infra/parameters/prod.bicepparam`**:

```bicep
using '../main.bicep'

param environment = 'prod'
param location = 'westeurope'
param acrName = 'autopodprodacr'
param daemonImageTag = 'latest'  // Overridden in CI with commit SHA
```

### Daemon Dockerfile

**File**: `Dockerfile` (project root)

```dockerfile
# ─── Build stage ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config first (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/validator/package.json packages/validator/
COPY packages/escalation-mcp/package.json packages/escalation-mcp/

# Install dependencies
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/
COPY packages/validator/ packages/validator/
COPY packages/escalation-mcp/ packages/escalation-mcp/
COPY tsconfig.base.json ./

# Build all packages
RUN pnpm run build

# ─── Production stage ──────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache tini git docker-cli

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/packages/daemon/dist ./packages/daemon/dist
COPY --from=builder /app/packages/daemon/package.json ./packages/daemon/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/validator/dist ./packages/validator/dist
COPY --from=builder /app/packages/validator/package.json ./packages/validator/
COPY --from=builder /app/packages/escalation-mcp/dist ./packages/escalation-mcp/dist
COPY --from=builder /app/packages/escalation-mcp/package.json ./packages/escalation-mcp/

# Copy workspace config for production install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Install production dependencies only
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# Create non-root user
RUN addgroup -g 1000 autopod && \
    adduser -u 1000 -G autopod -s /bin/sh -D autopod

# Create data directory for SQLite
RUN mkdir -p /data && chown autopod:autopod /data

USER autopod

EXPOSE 3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/daemon/dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
```

### GitHub Actions Workflow

**File**: `.github/workflows/deploy.yml`

```yaml
name: Deploy Autopod

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: 'dev'
        type: choice
        options:
          - dev
          - prod

permissions:
  id-token: write    # OIDC for Azure login
  contents: read

env:
  ACR_NAME_DEV: autopoddevacr
  ACR_NAME_PROD: autopodprodacr
  RESOURCE_GROUP_DEV: autopod-dev-rg
  RESOURCE_GROUP_PROD: autopod-prod-rg

jobs:
  build-and-push:
    name: Build & Push Image
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - name: Set environment
        id: env
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "environment=${{ inputs.environment }}" >> "$GITHUB_OUTPUT"
          else
            echo "environment=dev" >> "$GITHUB_OUTPUT"
          fi

      - name: Azure login (OIDC)
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Set ACR name
        id: acr
        run: |
          if [ "${{ steps.env.outputs.environment }}" = "prod" ]; then
            echo "name=${{ env.ACR_NAME_PROD }}" >> "$GITHUB_OUTPUT"
          else
            echo "name=${{ env.ACR_NAME_DEV }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Login to ACR
        run: az acr login --name ${{ steps.acr.outputs.name }}

      - name: Docker image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ steps.acr.outputs.name }}.azurecr.io/autopod/daemon
          tags: |
            type=sha,prefix=
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=registry,ref=${{ steps.acr.outputs.name }}.azurecr.io/autopod/daemon:buildcache
          cache-to: type=registry,ref=${{ steps.acr.outputs.name }}.azurecr.io/autopod/daemon:buildcache,mode=max

  deploy:
    name: Deploy Infrastructure
    needs: build-and-push
    runs-on: ubuntu-latest
    environment: ${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'dev' }}
    steps:
      - uses: actions/checkout@v4

      - name: Set environment
        id: env
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "environment=${{ inputs.environment }}" >> "$GITHUB_OUTPUT"
          else
            echo "environment=dev" >> "$GITHUB_OUTPUT"
          fi

      - name: Azure login (OIDC)
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Set resource group
        id: rg
        run: |
          if [ "${{ steps.env.outputs.environment }}" = "prod" ]; then
            echo "name=${{ env.RESOURCE_GROUP_PROD }}" >> "$GITHUB_OUTPUT"
          else
            echo "name=${{ env.RESOURCE_GROUP_DEV }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Deploy Bicep
        uses: azure/arm-deploy@v2
        with:
          resourceGroupName: ${{ steps.rg.outputs.name }}
          template: infra/main.bicep
          parameters: >-
            infra/parameters/${{ steps.env.outputs.environment }}.bicepparam
            daemonImageTag=${{ needs.build-and-push.outputs.image-tag }}

      - name: Health check
        run: |
          FQDN=$(az containerapp show \
            --name autopod-${{ steps.env.outputs.environment }}-daemon \
            --resource-group ${{ steps.rg.outputs.name }} \
            --query properties.configuration.ingress.fqdn \
            --output tsv)

          echo "Checking health at https://${FQDN}/health"

          for i in $(seq 1 30); do
            STATUS=$(curl -s -o /dev/null -w '%{http_code}' "https://${FQDN}/health" || true)
            if [ "$STATUS" = "200" ]; then
              echo "Health check passed!"
              exit 0
            fi
            echo "Attempt $i/30: HTTP $STATUS — waiting 10s..."
            sleep 10
          done

          echo "Health check failed after 30 attempts"
          exit 1
```

### Entra ID Setup (Manual Steps)

Entra ID app registration can't be fully automated with Bicep. Document these manual steps in `infra/README.md`:

1. **Create App Registration**
   ```bash
   az ad app create --display-name "Autopod" \
     --sign-in-audience "AzureADMyOrg" \
     --web-redirect-uris "http://localhost:3000/auth/callback"
   ```

2. **Add App Roles**
   ```json
   [
     { "displayName": "Admin", "value": "admin", "allowedMemberTypes": ["User"] },
     { "displayName": "Operator", "value": "operator", "allowedMemberTypes": ["User"] },
     { "displayName": "Viewer", "value": "viewer", "allowedMemberTypes": ["User"] }
   ]
   ```

3. **API Permissions**: `User.Read` (delegated)

4. **Client Secret**: Create and store in Key Vault as `entra-client-secret`

5. **Assign Users**: Assign app roles to users/groups in Enterprise Applications

6. **Update Daemon Config**: Set `ENTRA_CLIENT_ID` and `ENTRA_TENANT_ID` environment variables

### File Summary

| File | Purpose |
|------|---------|
| `infra/main.bicep` | Orchestrator — deploys all modules |
| `infra/modules/container-apps.bicep` | Container Apps Environment + daemon app + storage |
| `infra/modules/acr.bicep` | Azure Container Registry + AcrPull role assignment |
| `infra/modules/keyvault.bicep` | Key Vault + RBAC role assignment |
| `infra/modules/identity.bicep` | User-assigned Managed Identity |
| `infra/modules/log-analytics.bicep` | Log Analytics workspace |
| `infra/parameters/dev.bicepparam` | Dev environment parameters |
| `infra/parameters/prod.bicepparam` | Production parameters |
| `Dockerfile` | Multi-stage daemon production image |
| `.github/workflows/deploy.yml` | CI/CD: build image, deploy infra, health check |

### Testing

```bash
# Validate Bicep templates (syntax + type checking)
az bicep build --file infra/main.bicep

# What-if deployment (dry run)
az deployment group what-if \
  --resource-group autopod-dev-rg \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam

# Deploy to dev
az deployment group create \
  --resource-group autopod-dev-rg \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam

# Verify daemon is running
az containerapp show \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg \
  --query properties.runningStatus

# Test health endpoint
curl https://$(az containerapp show \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg \
  --query properties.configuration.ingress.fqdn \
  --output tsv)/health

# Verify scale-to-zero (wait 10 minutes with no traffic)
az containerapp replica list \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg
# Should return empty list

# Build and test Docker image locally
docker build -t autopod-daemon:test .
docker run -p 3000:3000 -e DB_PATH=/data/autopod.db autopod-daemon:test
curl http://localhost:3000/health
```

### Acceptance Criteria

- [ ] `az bicep build --file infra/main.bicep` passes with no errors
- [ ] `az deployment group create` deploys all infrastructure to a fresh resource group
- [ ] Daemon Container App starts and responds to `/health` with HTTP 200
- [ ] Key Vault secrets are readable by the daemon via Managed Identity
- [ ] ACR images are pullable by the Container App via Managed Identity
- [ ] SQLite database persists across container restarts (Azure File Share mount)
- [ ] Scale-to-zero works: no replicas running when idle, no cost accrued
- [ ] Scale-up works: replicas increase under load (> 10 concurrent requests)
- [ ] Health probes (startup, liveness, readiness) all function correctly
- [ ] GitHub Actions workflow builds, pushes, deploys, and health-checks on push to main
- [ ] Workflow uses OIDC authentication (no stored Azure credentials in GitHub)
- [ ] Separate dev/prod parameter files produce correctly-named resources
- [ ] Daemon Dockerfile builds successfully and runs as non-root user (UID 1000)
- [ ] `tini` is used as PID 1 for proper signal forwarding to the Node process
- [ ] No secret values exist in Bicep templates or parameter files

---

## Phase 5 Dependency Summary

```mermaid
graph TD
    M7[M7: Session Manager] --> M12[M12: Correction Flow]
    M8[M8: Escalation MCP] --> M12
    M3[M3: Runtime Adapters] --> M13[M13: Codex Runtime]
    M2[M2: Container Engine] --> M14[M14: Image Warming]
    M5[M5: Profile System] --> M14

    M12 --> M15[M15: Azure Deployment]
    M13 --> M15
    M14 --> M15

    style M12 fill:#f5e6d5,stroke:#333
    style M13 fill:#f5e6d5,stroke:#333
    style M14 fill:#f5e6d5,stroke:#333
    style M15 fill:#f5d5d5,stroke:#333
```

**Estimated effort**: M12 and M13 are medium complexity (2–3 days each). M14 is medium-high (3–4 days, Docker + ACR integration). M15 is the heaviest (4–5 days, infrastructure + CI/CD + manual Entra steps). With three parallel agents on M12–M14 and a sequential M15, Phase 5 takes roughly 7–8 working days.
