import { fork } from 'node:child_process';
import path from 'node:path';
import type { FixtureMessage } from './local-reconciler-process-fixture.js';

const MAX_BYTES = 256 * 1024;
const DEADLINE_MS = 20_000;

/** Own one IPC child. A watchdog kill is always a failure, never crash evidence. */
export function startFixtureProcess(bundle: string, args: string[], root: string) {
  const child = fork(bundle, args, {
    execPath: process.execPath,
    execArgv: [],
    cwd: root,
    env: {
      HOME: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      TMP: path.join(root, 'tmp'),
      TEMP: path.join(root, 'tmp'),
      NODE_ENV: 'test',
      LANG: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let failure: Error | undefined;
  let output = '';
  let outputBytes = 0;
  let messageCount = 0;
  let closed = false;
  let resolveMessage: (message: FixtureMessage) => void;
  let rejectMessage: (error: Error) => void;
  let rejectFailure: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const message = new Promise<FixtureMessage>((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  });
  // Keep early failures handled until the test reaches this child's barrier.
  void message.catch(() => {});
  const fail = (error: Error) => {
    failure ??= error;
    rejectMessage(error);
    rejectFailure(error);
    if (!closed) child.kill('SIGKILL');
  };
  const watchdog = setTimeout(
    () => fail(new Error('Fixture process deadline exceeded')),
    DEADLINE_MS,
  );
  child.on('error', fail);
  child.on('message', (payload: unknown) => {
    messageCount++;
    if (
      messageCount !== 1 ||
      Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES ||
      !payload ||
      typeof payload !== 'object' ||
      !('type' in payload) ||
      (payload.type !== 'ready' && payload.type !== 'recovered')
    ) {
      fail(new Error('Invalid or oversized fixture IPC message'));
      return;
    }
    resolveMessage(payload as FixtureMessage);
  });
  const capture = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_BYTES) {
      fail(new Error('Fixture output exceeded limit'));
    } else {
      output += chunk.toString('utf8');
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(watchdog);
      if (messageCount === 0)
        fail(new Error(`Fixture closed before IPC: ${code}/${signal}\n${output}`));
      resolve({ code, signal });
    });
  });
  // Bound waits even if an OS/transport failure prevents the close event.
  const observedExit = Promise.race([exit, failed]);
  void observedExit.catch(() => {});

  return {
    child,
    message,
    exit: observedExit,
    assertHealthy() {
      if (failure) throw new Error(`${failure.message}\n${output}`);
    },
    async dispose() {
      if (!closed) child.kill('SIGKILL');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned child did not close')), 5_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        clearTimeout(watchdog);
      }
    },
  };
}
