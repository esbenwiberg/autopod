import { AutopodError, type RuntimeType, processContent } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

const cliByRuntime: Record<RuntimeType, string> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  pi: 'pi',
};
const minimumCodexVersion = [0, 144, 4] as const;
export interface VerifiedAgentCli {
  cliPath: string | null;
  cliVersion: string;
}

/** Fixed read-only probes; never run repository-provided command strings. */
export async function verifyAgentCli(
  cm: ContainerManager,
  containerId: string,
  runtime: RuntimeType,
): Promise<VerifiedAgentCli> {
  const cli = cliByRuntime[runtime];
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
      `Unable to verify the ${label} CLI version. Rebuild the ${runtime} base/warm image${runtime === 'codex' ? ' with Codex CLI 0.144.4 or newer' : ''}.`,
      'PREFLIGHT_RUNTIME_UNAVAILABLE',
      409,
    );
  if (runtime === 'codex') {
    for (const [index, minimum] of minimumCodexVersion.entries()) {
      const current = version[index] ?? 0;
      if (current > minimum) break;
      if (current < minimum)
        throw new AutopodError(
          `Codex CLI ${version.join('.')} is incompatible; Autopod requires 0.144.4 or newer. Rebuild the codex base/warm image.`,
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
