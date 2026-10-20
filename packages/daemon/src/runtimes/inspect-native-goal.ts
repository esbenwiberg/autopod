import { randomUUID } from 'node:crypto';
import {
  CONTAINER_HOME_DIR,
  type NativeGoalObservation,
  type NativeGoalProcessHooks,
} from '@autopod/shared';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import {
  CodexAppServerClient,
  CodexRpcError,
  terminateCodexAppServer,
} from './codex-app-server-client.js';
import { CodexAppServerGoalSession } from './codex-app-server-goal-session.js';
import { codexGoalRolloutPath } from './codex-goal-usage.js';

/** No account environment, agent shim, workspace config, thread load, or continuation RPC. */
export async function inspectNativeGoal(input: {
  manager: ContainerManager;
  containerId: string;
  sessionId: string;
  hooks: NativeGoalProcessHooks;
  observe(value: NativeGoalObservation): void;
}): Promise<void> {
  const home = `/tmp/.autopod-goal-inspection-${randomUUID()}`;
  // Codex refuses an explicit CODEX_HOME that does not already exist.
  const prepared = await input.manager.execInContainer(
    input.containerId,
    ['mkdir', '-m', '0700', home],
    { timeout: 5000 },
  );
  if (prepared.exitCode !== 0) throw new CodexRpcError('INSPECTION_HOME_UNAVAILABLE');
  let handle: StreamingExecResult | undefined;
  let session: CodexAppServerGoalSession | undefined;
  try {
    handle = await input.manager.execStreaming(
      input.containerId,
      [
        'env',
        '-i',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        `HOME=${CONTAINER_HOME_DIR}`,
        `CODEX_HOME=${home}`,
        'codex',
        '-c',
        `sqlite_home="${CONTAINER_HOME_DIR}/.codex/sessions/.autopod-goal-state"`,
        'app-server',
      ],
      {
        cwd: '/',
        stdin: true,
        onProcessCreated: input.hooks.processCreated,
        onProcessStarted: input.hooks.processStarted,
      },
    );
    if (!handle.stdin) throw new CodexRpcError('STDIN_UNAVAILABLE');
    session = new CodexAppServerGoalSession(
      new CodexAppServerClient(handle),
      { model: 'unused', cwd: '/', developerInstructions: '' },
      (path) => input.manager.readFile(input.containerId, codexGoalRolloutPath(path)),
    );
    await session.openInspection(input.sessionId);
    const saved = await session.get();
    if (!saved) throw new CodexRpcError('GOAL_RECONCILIATION_REQUIRED');
    input.observe(saved);
    if (saved.nativeStatus === 'active') {
      const paused = await session.pause();
      if (paused.nativeStatus !== 'paused') throw new CodexRpcError('GOAL_PAUSE_UNCONFIRMED');
      input.observe(paused);
    }
  } finally {
    if (handle) await terminateCodexAppServer(handle);
    const final = await session?.reconcileUsage();
    if (final) input.observe(final);
    await input.manager
      .execInContainer(input.containerId, ['rm', '-rf', '--', home], { timeout: 5000 })
      .catch(() => undefined);
  }
}
