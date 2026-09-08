import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { fixture } from '../test-utils/managed-fixture.js';
import { sha256 } from './canonical.js';
import { ContainerCodexChannel, codexReportCommand } from './codex-channel.js';
function setup() {
  const f = fixture();
  const request = structuredClone(f.request);
  f.close();
  request.effectiveGrant.budget.maxDurationSeconds = 180;
  const exec = vi
    .fn<ContainerManager['execInContainer']>()
    .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  const manager = { execInContainer: exec } as unknown as ContainerManager;
  return { request, exec, channel: new ContainerCodexChannel(manager, request.route, 4095) };
}
it.each(['network', 'identity', 'duration', 'model', 'source'])(
  'fails %s preflight before any exec',
  async (kind) => {
    const { request, exec, channel } = setup();
    if (kind === 'network')
      request.effectiveGrant.scope.network.destinations.push('api.openai.com');
    if (kind === 'identity') request.effectiveGrant.scope.identityBindings.push({} as never);
    if (kind === 'duration') request.effectiveGrant.budget.maxDurationSeconds = 181;
    if (kind === 'model') request.route.model = 'other';
    if (kind === 'source') request.outputs.source.mode = 'branch';
    await expect(channel.preflight(request)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  },
);
it('rejects an incompatible immutable-image Codex CLI before installing helpers', async () => {
  const { request, exec, channel } = setup();
  await channel.preflight(request);
  await expect(
    channel.attach({
      podId: 'managed-one',
      runtimeRef: 'ref',
      stateRoot: '/run/dispatcher-managed-one',
      invoke: vi.fn(),
    }),
  ).rejects.toThrow('cli-incompatible');
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0]).toEqual(['ref', ['codex', 'exec', '--help'], { user: 'root' }]);
});

it.each([false, true])('polls one digest-bound request; tampered=%s', async (tampered) => {
  vi.useFakeTimers();
  const { request, exec, channel } = setup();
  const raw = JSON.stringify({
    model: request.route.model,
    input: [{ role: 'user', content: 'Fact.' }],
    reasoning: { effort: request.route.reasoning },
    stream: true,
    store: false,
  });
  const writes: string[][] = [];
  let read = false;
  exec.mockImplementation(async (_ref, argv) => {
    if (argv[0] === 'codex')
      return { exitCode: 0, stdout: '--ephemeral --output-last-message --sandbox', stderr: '' };
    const code = argv[2] ?? '';
    if (code.includes('urllib.request')) return { exitCode: 0, stdout: '204', stderr: '' };
    if (code.includes('p.stat().st_size')) {
      if (read) return { exitCode: 0, stdout: '', stderr: '' };
      read = true;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          body: raw,
          digest: tampered ? '0'.repeat(64) : sha256(raw).slice(7),
          ticket: 'a'.repeat(36),
        }),
        stderr: '',
      };
    }
    if (code.includes('delivery-binding')) writes.push(argv);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const invoke = vi.fn(async () => ({ state: 'observed' as const, value: 'data: fixture\n\n' }));
  let close: (() => void) | undefined;
  try {
    close = await channel.attach({
      podId: 'managed-one',
      runtimeRef: 'ref',
      stateRoot: '/run/dispatcher-managed-one',
      invoke,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenCalledTimes(tampered ? 0 : 1);
    expect(writes).toHaveLength(tampered ? 0 : 1);
    if (!tampered) {
      expect(invoke).toHaveBeenCalledWith('codex-report-one', raw, 4095);
      expect(writes[0]?.at(-1)).toBe('a'.repeat(36));
    }
    expect(codexReportCommand(request.route, 'fixture-repo')).toContain(
      '/repositories/fixture-repo/README.md',
    );
    expect(codexReportCommand(request.route, 'fixture-repo', 'research')).toContain(
      '/inputs/research',
    );
  } finally {
    close?.();
    vi.useRealTimers();
  }
});
