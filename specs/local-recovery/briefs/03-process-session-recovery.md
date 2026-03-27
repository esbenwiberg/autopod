# Brief: processSession() Recovery Path

## Objective
Teach `processSession()` to detect recovered sessions and handle them
differently: skip worktree creation, attempt Claude `--resume`, fall back
to fresh spawn with continuation context.

## Dependencies
- Brief 01 (DB + types) — `recoveryWorktreePath` field
- Brief 02 (local reconciler) — sessions arrive with recovery flag set

## Blocked By
Brief 01 and Brief 02.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/session-manager.ts` | modify | Recovery path in `processSession()` |
| `packages/daemon/src/sessions/recovery-context.ts` | create | Builds continuation prompt from git state |

## Implementation Notes

### processSession() changes (session-manager.ts)

**Early in the function, after getting the session and profile:**

```typescript
// Recovery mode: reuse existing worktree instead of creating new one
let worktreePath: string;
let bareRepoPath: string;

if (session.recoveryWorktreePath) {
  worktreePath = session.recoveryWorktreePath;
  bareRepoPath = await deriveBareRepoPath(worktreePath);
  // Clear recovery flag now that we've captured the path
  sessionRepo.update(sessionId, { recoveryWorktreePath: null });
  emitStatus('Recovering session — reusing existing worktree…');
  logger.info({ sessionId, worktreePath }, 'Recovery mode: reusing worktree');
} else {
  // Normal path: create worktree
  emitStatus('Creating worktree…');
  const result = await worktreeManager.create({ ... });
  worktreePath = result.worktreePath;
  bareRepoPath = result.bareRepoPath;
}
```

**`deriveBareRepoPath()` helper** (add to session-manager.ts or a util):

```typescript
async function deriveBareRepoPath(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['rev-parse', '--git-common-dir'],
    { cwd: worktreePath },
  );
  return path.resolve(worktreePath, stdout.trim());
}
```

**At the agent spawn point, after container setup:**

```typescript
// Start the agent — recovery mode uses resume for Claude, fresh spawn for others
emitStatus('Spawning agent…');
const runtime = runtimeRegistry.get(session.runtime);
let events: AsyncIterable<AgentEvent>;

if (isRecovery && session.runtime === 'claude' && session.claudeSessionId) {
  // Attempt Claude --resume with persisted session ID
  emitStatus('Resuming Claude session…');

  // Rehydrate the in-memory session ID map
  if ('setClaudeSessionId' in runtime) {
    (runtime as ClaudeRuntime).setClaudeSessionId(sessionId, session.claudeSessionId);
  }

  const continuationPrompt = await buildContinuationPrompt(session, worktreePath);
  events = runtime.resume(sessionId, continuationPrompt, containerId, secretEnv);
} else if (isRecovery) {
  // Non-Claude runtime or no claudeSessionId — fresh spawn with recovery context
  const recoveryTask = await buildRecoveryTask(session, worktreePath);
  events = runtime.spawn({
    sessionId,
    task: recoveryTask,
    model: session.model,
    workDir: '/workspace',
    containerId,
    customInstructions: session.runtime === 'copilot' ? systemInstructions : undefined,
    env: secretEnv,
    mcpServers,
  });
} else {
  // Normal path
  events = runtime.spawn({ ... });
}

await this.consumeAgentEvents(sessionId, events);
```

### recovery-context.ts

Builds context-rich prompts for the recovering agent:

```typescript
export async function buildContinuationPrompt(
  session: Session,
  worktreePath: string,
): Promise<string> {
  // Get recent git log on this branch
  const gitLog = await getGitLog(worktreePath, 10);
  const uncommittedDiff = await getUncommittedDiff(worktreePath);

  return [
    'Your session was interrupted and is being recovered.',
    'Your previous work is preserved in the worktree.',
    '',
    `Original task: ${session.task}`,
    '',
    gitLog ? `Recent commits on this branch:\n${gitLog}` : 'No commits on this branch yet.',
    '',
    uncommittedDiff ? `Uncommitted changes:\n${uncommittedDiff}` : 'No uncommitted changes.',
    '',
    'Check the plan and git log to determine where you left off, then continue.',
  ].join('\n');
}

export async function buildRecoveryTask(
  session: Session,
  worktreePath: string,
): Promise<string> {
  const continuationContext = await buildContinuationPrompt(session, worktreePath);
  return `${session.task}\n\n---\n\nRECOVERY CONTEXT:\n${continuationContext}`;
}
```

### Error handling for Claude --resume

If `runtime.resume()` throws or yields a fatal error (e.g., session expired):
- Catch the error
- Log it as a warning
- Fall back to fresh `runtime.spawn()` with `buildRecoveryTask()`
- This happens naturally in `consumeAgentEvents` — a fatal error event
  triggers `handleCompletion()` which moves to validation

Actually, better approach: wrap the resume attempt:

```typescript
try {
  events = runtime.resume(...);
  // Peek at first event — if it's a fatal error, fall back
  // (We can't easily peek at an async iterable, so just let it flow
  //  and handle failure in consumeAgentEvents → handleCompletion)
} catch (err) {
  logger.warn({ err, sessionId }, 'Claude --resume failed, falling back to fresh spawn');
  events = runtime.spawn({ task: recoveryTask, ... });
}
```

The `resume()` method calls `containerManager.execStreaming()` which can throw
if the exec setup fails. If it throws, we catch and fall back. If it succeeds
but Claude reports a fatal error (expired session), that flows through
`consumeAgentEvents` normally and triggers validation/completion.

## Acceptance Criteria

- [ ] Recovered sessions skip worktree creation and reuse existing worktree
- [ ] `bareRepoPath` correctly derived from existing worktree
- [ ] Claude sessions use `--resume` with persisted `claudeSessionId`
- [ ] `ClaudeRuntime.claudeSessionIds` map is rehydrated on recovery
- [ ] Copilot/Codex sessions get fresh spawn with recovery context
- [ ] If Claude `--resume` fails at exec level, falls back to fresh spawn
- [ ] Recovery context includes git log and uncommitted diff
- [ ] `recoveryWorktreePath` cleared after recovery starts
- [ ] Normal (non-recovery) sessions are completely unaffected
- [ ] `npx pnpm build` and `npx pnpm test` pass

## Estimated Scope
Files: 2 | Complexity: medium-high
