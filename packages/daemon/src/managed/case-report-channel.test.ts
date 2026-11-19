import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { requestTimeFixture } from '../test-utils/managed-fixture.js';
import { sha256 } from './canonical.js';
import { ChatGptReportTransport } from './chatgpt-provider.js';
import { ContainerCodexChannel } from './codex-channel.js';
import { ManagedProviderGateway } from './provider-gateway.js';

it('connects the report-only container channel to one metered, tool-free Responses call', async () => {
  const f = requestTimeFixture(1);
  const req = f.request,
    route = req.route;
  const service = f.service(),
    h = await service.start('installation', req);
  const raw = JSON.stringify({
    model: route.model,
    reasoning: { effort: route.reasoning },
    input: [{ role: 'user', content: 'frozen file values' }],
    tools: [{ type: 'custom', name: 'untrusted' }],
    stream: true,
    store: false,
  });
  const wire = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).tools).toEqual([]);
    const response = {
      model: route.model,
      status: 'completed',
      usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Observed 42.' }],
        },
      ],
    };
    return new Response(
      'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const transport = new ChatGptReportTransport(
    route,
    'fixture',
    async () => ({
      mode: 'chatgpt',
      accountId: route.providerAccountId,
      chatgptAccountId: 'fixture',
      token: 'test-only',
    }),
    wire,
  );
  const gw = new ManagedProviderGateway(service, transport, 1);
  let pending = true,
    published = '';
  const manager = {
    execInContainer: async (_ref: string, argv: string[]) => {
      let stdout = '';
      if (argv[0] === 'codex') stdout = '--output-last-message --sandbox';
      else if (argv[2]?.includes('immutable-case-worker')) {
        expect(argv[5]).toBe('180');
        expect(argv[10]).toContain('def case_data');
      } else if (argv[2]?.includes('urllib.request')) stdout = '204';
      else if (
        argv[2]?.includes('request.json') &&
        argv[2]?.includes('print(p.read_text())') &&
        pending
      ) {
        pending = false;
        stdout = JSON.stringify({
          digest: sha256(raw).slice(7),
          body: raw,
          ticket: '0'.repeat(36),
        });
      } else if (argv[2]?.includes('delivery-binding') && argv[6] === 'true') published = argv[7]!;
      return { exitCode: 0, stdout, stderr: '' };
    },
    writeFile: async (_ref: string, _file: string, data: string) => {
      published = JSON.parse(data).body;
    },
  } as unknown as ContainerManager;
  const ch = new ContainerCodexChannel(manager, route, 0, { mode: 'case-report' });
  let detach: (() => void) | undefined;
  try {
    await ch.preflight(req);
    const invalid = structuredClone(req);
    invalid.effectiveGrant.budget.maxDurationSeconds = 181;
    await expect(ch.preflight(invalid)).rejects.toThrow('duration');
    detach = await ch.attach({
      podId: h.podId,
      runtimeRef: 'fixture',
      stateRoot: '/run/dispatcher-' + h.podId,
      invoke: (k, p, t) => gw.invoke('installation', h.podId, 1, k, p, t),
    });
    await vi.waitFor(() => expect(published).toContain('Observed 42.'), { timeout: 4000 });
    await expect(
      gw.invoke('installation', h.podId, 1, 'new-provider-operation', raw, 0),
    ).rejects.toThrow('request-limit');
    expect(wire).toHaveBeenCalledOnce();
    expect(f.db.prepare('select state,actual_tokens from managed_provider_requests').get()).toEqual(
      { state: 'observed', actual_tokens: 14 },
    );
  } finally {
    detach?.();
    gw.close();
    f.close();
  }
});
