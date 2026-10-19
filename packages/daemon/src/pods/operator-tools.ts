import { AutopodError } from '@autopod/shared';
import type { OperatorToolsCaptured } from './operator-contracts.js';
export function createOperatorTools(captured: OperatorToolsCaptured) {
  const { podRepo, containerManagerFactory, emitActivityStatus, installGhBinary, installAzViaPip } =
    captured;
  async function injectCredential(_podId: string, _service: 'github' | 'ado'): Promise<void> {
    throw new AutopodError(
      'Source credentials stay with the AutoPod daemon. Use scoped access tools; push and PR delivery are daemon-owned.',
      'SOURCE_CREDENTIAL_INJECTION_DISABLED',
      410,
    );
  }

  async function installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status !== 'running') {
      throw new AutopodError(
        `Pod ${podId} is ${pod.status} — can only install tools into running pods.`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.containerId) {
      throw new AutopodError(`Pod ${podId} has no running container`, 'INVALID_STATE', 409);
    }
    const cm = containerManagerFactory.get(pod.executionTarget);
    const containerId = pod.containerId;

    const check = await cm.execInContainer(containerId, ['sh', '-c', `command -v ${tool}`]);
    if (check.exitCode === 0) {
      emitActivityStatus(podId, `${tool} is already installed.`);
      return;
    }

    emitActivityStatus(podId, `Installing ${tool} CLI…`);
    if (tool === 'gh') {
      await installGhBinary(cm, containerId, podId);
    } else {
      await installAzViaPip(cm, containerId, podId);
    }
    emitActivityStatus(podId, `${tool} CLI installed.`);
  }
  return { injectCredential, installCliTool };
}
