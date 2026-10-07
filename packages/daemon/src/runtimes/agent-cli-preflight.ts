import { AutopodError, type RuntimeType, processContent } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

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

/** Fixed read-only probes; never run repository-provided command strings. */
export async function verifyAgentCli(
  cm: ContainerManager,
  containerId: string,
  runtime: RuntimeType,
  model?: string | null,
): Promise<VerifiedAgentCli> {
  const cli = cliByRuntime[runtime];
  const minimum = codexMinimum(model).join('.');
  const location = await cm.execInContainer(containerId, ['sh', '-lc', `command -v ${cli}`], {
    timeout: 10000,
  });
  const detail = processContent((location.stderr || location.stdout).slice(0, 400), {
    sanitization: { preset: 'standard' },
  }).text.trim();
  if (location.exitCode !== 0)
    throw new AutopodError(
      `Agent CLI missing: ${cli} is not installed in this image. Rebuild the ${runtime} base/warm image.${detail ? ` ${detail}` : ''}`,
      'PREFLIGHT_RUNTIME_UNAVAILABLE',
      409,
    );
  const result = await cm.execInContainer(containerId, [cli, '--version'], { timeout: 10000 });
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
