import { AutopodError, processContent, type RuntimeType } from '@autopod/shared';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';

const cliByRuntime: Record<RuntimeType, string> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  pi: 'pi',
};
const minimumCodexVersion = [0, 144, 4] as const;
/** GPT-6 model families are unknown to Codex CLIs released before them. */
const minimumCodexVersionForGpt6 = [0, 160, 1] as const;
const codexMinimum = (model: string | null | undefined) =>
  model?.startsWith('gpt-6') ? minimumCodexVersionForGpt6 : minimumCodexVersion;
export interface VerifiedAgentCli {
  cliPath: string | null;
  cliVersion: string;
}

/**
 * Per-exec ceiling for the fixed CLI probes. Native agent CLIs are large
 * binaries (Claude's is ~220 MB); a cold start right after a heavy validation
 * and workspace sync-back can exceed the former 10 s ceiling on a busy host.
 */
export const AGENT_CLI_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2_000;

export interface VerifyAgentCliOptions
  extends Pick<ExecOptions, 'assertCurrent' | 'cwd' | 'env' | 'user' | 'maxOutputBytes'> {
  /**
   * Total attempts when a probe fails without an observed answer (exec
   * timeout, Docker transport error). Observed answers — a missing CLI or an
   * unusable version — are never retried. Defaults to one attempt.
   */
  transientAttempts?: number;
  /** Delay before each transient retry. */
  transientRetryDelayMs?: number;
}

/** Bounded, sanitized description of an unobserved probe failure. */
export function describeAgentCliProbeFailure(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown error');
  return processContent(raw.replace(/\s+/g, ' ').slice(0, 300), {
    sanitization: { preset: 'standard' },
  }).text.trim();
}

/**
 * Fixed read-only probes; never run repository-provided command strings.
 * Probes are idempotent, so a transport failure without an observed answer can
 * be retried within `transientAttempts`. The result stays fail-closed: every
 * attempt must fail to observe the CLI before the caller sees the error.
 */
export async function verifyAgentCli(
  cm: ContainerManager,
  containerId: string,
  runtime: RuntimeType,
  model?: string | null,
  options: VerifyAgentCliOptions = {},
): Promise<VerifiedAgentCli> {
  const { transientAttempts, transientRetryDelayMs, ...execOptions } = options;
  const attempts = Math.max(1, Math.floor(transientAttempts ?? 1));
  for (let attempt = 1; ; attempt++) {
    try {
      return await probeAgentCli(cm, containerId, runtime, model, execOptions);
    } catch (error) {
      // An observed answer (or a superseded owner) is authoritative.
      if (error instanceof AutopodError || attempt >= attempts) throw error;
      options.assertCurrent?.();
      await new Promise((resolve) =>
        setTimeout(resolve, transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS * attempt),
      );
      options.assertCurrent?.();
    }
  }
}

async function probeAgentCli(
  cm: ContainerManager,
  containerId: string,
  runtime: RuntimeType,
  model: string | null | undefined,
  options: Pick<ExecOptions, 'assertCurrent' | 'cwd' | 'env' | 'user' | 'maxOutputBytes'>,
): Promise<VerifiedAgentCli> {
  const exec = async (command: string[]) => {
    options.assertCurrent?.();
    try {
      return await cm.execInContainer(containerId, command, {
        ...options,
        timeout: AGENT_CLI_PROBE_TIMEOUT_MS,
      });
    } finally {
      options.assertCurrent?.();
    }
  };
  const cli = cliByRuntime[runtime];
  const minimum = codexMinimum(model).join('.');
  const location = await exec([
    options.user ? '/bin/sh' : 'sh',
    options.user ? '-c' : '-lc',
    `command -v ${cli}`,
  ]);
  const detail = processContent((location.stderr || location.stdout).slice(0, 400), {
    sanitization: { preset: 'standard' },
  }).text.trim();
  if (location.exitCode !== 0)
    throw new AutopodError(
      `Agent CLI missing: ${cli} is not installed in this image. Rebuild the ${runtime} base/warm image.${detail ? ` ${detail}` : ''}`,
      'PREFLIGHT_RUNTIME_UNAVAILABLE',
      409,
    );
  const result = await exec([cli, '--version']);
  const output = (result.stdout || result.stderr).trim();
  const match = output.length <= 4096 ? output.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
  const version = match?.slice(1).map(Number);
  const label = runtime === 'codex' ? 'Codex' : cli;
  if (result.exitCode !== 0 || !version || version.some((value) => !Number.isSafeInteger(value)))
    throw new AutopodError(
      `Unable to verify the ${label} CLI version. Rebuild the ${runtime} base/warm image${runtime === 'codex' ? ` with Codex CLI ${minimum} or newer` : ''}.`,
      'PREFLIGHT_RUNTIME_UNAVAILABLE',
      409,
    );
  if (runtime === 'codex') {
    for (const [index, required] of codexMinimum(model).entries()) {
      const current = version[index] ?? 0;
      if (current > required) break;
      if (current < required)
        throw new AutopodError(
          `Codex CLI ${version.join('.')} is incompatible${model?.startsWith('gpt-6') ? ` with ${model}` : ''}; Autopod requires ${minimum} or newer. Rebuild the codex base/warm image.`,
          'PREFLIGHT_RUNTIME_INCOMPATIBLE',
          409,
        );
    }
  }
  const path = location.stdout.trim();
  return {
    cliVersion: version.join('.'),
    cliPath:
      path.length > 0 &&
      path.length <= 1024 &&
      ![...path].some((character) => character.charCodeAt(0) < 32)
        ? path
        : null,
  };
}
