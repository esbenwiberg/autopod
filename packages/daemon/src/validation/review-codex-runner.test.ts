import { describe, expect, it } from 'vitest';
import type { ContainerManager, ExecOptions, ExecResult } from '../interfaces/container-manager.js';
import { runCodexReview } from './review-codex-runner.js';

interface CapturedExec {
  command: string[];
  options?: ExecOptions;
}

function createHarness(
  result: ExecResult = { stdout: '{"status":"pass"}', stderr: '', exitCode: 0 },
) {
  const writes: Array<{ containerId: string; path: string; content: string | Buffer }> = [];
  const execs: CapturedExec[] = [];
  const manager: Pick<ContainerManager, 'writeFile' | 'execInContainer'> = {
    async writeFile(containerId, path, content) {
      writes.push({ containerId, path, content });
    },
    async execInContainer(_containerId, command, options) {
      execs.push({ command, options });
      return result;
    },
  };

  return { manager: manager as ContainerManager, writes, execs };
}

describe('runCodexReview', () => {
  it('builds a valid shell script around the Codex CLI call', async () => {
    const harness = createHarness();

    await runCodexReview({
      podId: 'pod/1',
      attempt: 2,
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'gpt-5-codex',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.containerId).toBe('container-1');
    expect(harness.writes[0]?.content).toBe('review prompt');
    expect(harness.execs).toHaveLength(1);

    const exec = harness.execs[0];
    expect(exec?.command[0]).toBe('sh');
    expect(exec?.command[1]).toBe('-c');
    expect(exec?.options).toEqual({ cwd: '/workspace', timeout: 1234 });

    const script = exec?.command[2] ?? '';
    expect(script).toContain('if [ "$status" -ne 0 ]; then\n');
    expect(script).not.toContain('then;');
    expect(script).toContain("--model 'gpt-5-codex'");
    expect(script).toContain("< '/tmp/autopod-codex-review-pod_1-2-");
    expect(script).toContain("> '/tmp/autopod-codex-review-pod_1-2-");
    expect(script).toContain("cat '/tmp/autopod-codex-review-pod_1-2-");
  });

  it('omits --model when model is auto', async () => {
    const harness = createHarness();

    await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'auto',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(harness.execs[0]?.command[2]).not.toContain('--model');
  });

  it('passes reviewer env through to the container exec', async () => {
    const harness = createHarness();

    await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'auto',
      prompt: 'review prompt',
      env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      timeout: 1234,
    });

    expect(harness.execs[0]?.options).toEqual({
      cwd: '/workspace',
      env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      timeout: 1234,
    });
  });

  it('throws a CodexReviewError when the in-container review command fails', async () => {
    const harness = createHarness({
      stdout: 'codex review failed (exit 2)\nsh: 1: Syntax error: ";" unexpected',
      stderr: '',
      exitCode: 2,
    });

    await expect(
      runCodexReview({
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: harness.manager,
        model: 'auto',
        prompt: 'review prompt',
        timeout: 1234,
      }),
    ).rejects.toMatchObject({
      name: 'CodexReviewError',
      kind: 'non-zero-exit',
      exitCode: 2,
    });
  });
});
