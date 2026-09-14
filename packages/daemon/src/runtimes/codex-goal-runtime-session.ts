import type { NativeGoalObservation, NativeGoalSession } from '@autopod/shared';
import type { StreamingExecResult } from '../interfaces/container-manager.js';
import {
  CodexAppServerClient,
  CodexRpcError,
  terminateCodexAppServer,
} from './codex-app-server-client.js';
import {
  CodexAppServerGoalSession,
  type CodexGoalThreadConfig,
} from './codex-app-server-goal-session.js';

/** Lazy process ownership: no app-server starts before the Goal controller admits its attempt. */
export class CodexGoalRuntimeSession implements NativeGoalSession {
  readonly runtime = 'codex' as const;
  private session: CodexAppServerGoalSession | null = null;
  private process: StreamingExecResult | null = null;
  private opening = false;
  private stopping = false;
  private acquisition: Promise<void> | null = null;
  private termination: Promise<void> | null = null;
  private acquisitionUncertain = false;
  constructor(
    private readonly options: {
      config: CodexGoalThreadConfig;
      prepare(): Promise<void>;
      spawn(): Promise<StreamingExecResult>;
      sessionOpened(id: string): void;
      stopped(): void;
    },
  ) {}
  async open(id: string | null): Promise<string> {
    if (this.opening || this.stopping) throw new CodexRpcError('SESSION_ALREADY_OPEN');
    this.opening = true;
    this.acquisition = (async () => {
      await this.options.prepare();
      if (this.stopping) return;
      this.acquisitionUncertain = true;
      const process = await this.options.spawn();
      this.process = process;
      // Even missing stdin retains a closeable handle. A half-open process must be terminated.
      if (!process.stdin) {
        try {
          await terminateCodexAppServer(process);
          this.acquisitionUncertain = false;
        } catch {
          throw new CodexRpcError('TERMINATION_UNCONFIRMED');
        }
        throw new CodexRpcError('STDIN_UNAVAILABLE');
      }
      this.session = new CodexAppServerGoalSession(
        new CodexAppServerClient(process),
        this.options.config,
      );
      this.acquisitionUncertain = false;
    })();
    await this.acquisition;
    if (this.stopping) throw new CodexRpcError('PROCESS_CLOSED');
    const sessionId = await this.ready().open(id);
    if (this.stopping) throw new CodexRpcError('PROCESS_CLOSED');
    this.options.sessionOpened(sessionId);
    return sessionId;
  }
  get() {
    return this.ready().get();
  }
  start(objective: string, remainingTokens: number | null) {
    return this.ready().start(objective, remainingTokens);
  }
  resume(remainingTokens: number | null) {
    return this.ready().resume(remainingTokens);
  }
  pause() {
    return this.ready().pause();
  }
  clear() {
    return this.ready().clear();
  }
  observations(): AsyncIterable<NativeGoalObservation> {
    return this.ready().observations();
  }
  stop(): Promise<void> {
    if (this.termination) return this.termination;
    this.stopping = true;
    const attempt = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            try {
              await this.acquisition;
            } catch {
              /* An uncertain process is not treated as stopped. */
            }
            if (this.acquisitionUncertain) {
              if (!this.process) throw new CodexRpcError('TERMINATION_UNCONFIRMED');
              await terminateCodexAppServer(this.process);
              this.acquisitionUncertain = false;
            }
            await this.session?.stop();
            this.options.stopped();
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new CodexRpcError('TERMINATION_UNCONFIRMED')), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.termination = attempt;
    // A later stop may reconcile an uncertain transport. Never permit another open on this adapter.
    void attempt.catch(() => {
      if (this.termination === attempt) this.termination = null;
    });
    return attempt;
  }
  private ready(): CodexAppServerGoalSession {
    if (!this.session) throw new CodexRpcError('SESSION_NOT_OPEN');
    return this.session;
  }
}
