import { readFileSync } from 'node:fs';
import type { ManagedPodRequest, Route } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { canonical, sha256 } from './canonical.js';
import { codexInput } from './codex-wire.js';
import type { ManagedWorkerProviderChannel } from './runtime-composition.js';

const INSTALL = `import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]);source=sys.argv[2];file=root/'codex_channel.py'
if root.is_symlink() or root.stat().st_uid!=0 or root.stat().st_mode & 0o077: raise RuntimeError('root')
if file.exists() and file.read_text()!=source: raise RuntimeError('immutable-channel')
file.write_text(source);os.chmod(file,0o600)
worker_root=pathlib.Path('/opt/dispatcher');worker_root.mkdir(mode=0o755,exist_ok=True)
if worker_root.is_symlink() or worker_root.stat().st_uid!=0 or worker_root.stat().st_mode & 0o022:raise RuntimeError('worker-root')
worker=worker_root/'codex_worker.py'
if worker.is_symlink() or (worker.exists() and worker.read_text()!=sys.argv[4]):raise RuntimeError('immutable-worker')
worker.write_text(sys.argv[4]);os.chmod(worker,0o555)
(root/'channel-closed').unlink(missing_ok=True)
with open(os.devnull,'wb') as sink: subprocess.Popen(['python3',str(file),str(root),'4187',sys.argv[3]],stdin=subprocess.DEVNULL,stdout=sink,stderr=sink,start_new_session=True)
`;
const READ = `import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);p=root/'channel-request.json';response=root/'channel-response.json'
if p.exists():
 if p.stat().st_size>270000: raise RuntimeError('size')
 request=json.loads(p.read_text())
 if not response.exists() or json.loads(response.read_text()).get('ticket')!=request['ticket']:print(p.read_text())
`;
const WRITE = `import json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);p=root/'channel-response.json';temp=root/'channel-response.tmp'
value={'digest':sys.argv[2],'ok':sys.argv[3]=='true','body':sys.argv[4],'ticket':sys.argv[5]}
request=json.loads((root/'channel-request.json').read_text())
if request['ticket']!=value['ticket'] or request['digest']!=value['digest']:raise RuntimeError('delivery-binding')
if p.exists() and json.loads(p.read_text()).get('ticket')==value['ticket']:
 if json.loads(p.read_text())!=value:raise RuntimeError('replay-conflict')
else:
 with temp.open('w') as f:json.dump(value,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
 os.replace(temp,p)
`;
/** Concrete container loopback -> root spool -> trusted exec -> attempt gateway channel.
 * Container egress must be denied; it carries no worker-held auth secret.
 */
export class ContainerCodexChannel implements ManagedWorkerProviderChannel {
  private readonly route: Route;
  private readonly source: string;
  private readonly worker: string;
  constructor(
    private readonly manager: ContainerManager,
    route: Route,
    private readonly maximumTokens: number,
  ) {
    this.route = structuredClone(route);
    this.source = readFileSync(new URL('./runtime/codex_channel.py', import.meta.url), 'utf8');
    this.worker = readFileSync(new URL('./runtime/codex_worker.py', import.meta.url), 'utf8');
    if (!Number.isSafeInteger(maximumTokens) || (maximumTokens !== 0 && maximumTokens < 2))
      throw new Error('managed-codex-budget-invalid');
  }
  async preflight(request: ManagedPodRequest) {
    if (canonical(this.route) !== canonical(request.route) || request.route.runtime !== 'codex')
      throw new Error('managed-codex-route-mismatch');
    if (
      request.effectiveGrant.scope.network.destinations.length ||
      request.effectiveGrant.scope.identityBindings.length ||
      ('maxTokens' in request.effectiveGrant.budget
        ? this.maximumTokens < 2 || this.maximumTokens >= request.effectiveGrant.budget.maxTokens
        : this.maximumTokens !== 0)
    )
      throw new Error('managed-codex-boundary-unavailable');
    if (request.effectiveGrant.budget.maxDurationSeconds > 180)
      throw new Error('managed-codex-canary-duration');
    if (request.outputs.source.mode !== 'none') throw new Error('managed-codex-report-only');
  }
  async attach(
    binding: Parameters<ManagedWorkerProviderChannel['attach']>[0],
  ): Promise<() => void> {
    if (
      !/^managed-[A-Za-z0-9-]+$/.test(binding.podId) ||
      binding.stateRoot !== `/run/dispatcher-${binding.podId}`
    )
      throw new Error('managed-codex-channel-binding');
    const exec = async (code: string, ...args: string[]) => {
      const result = await this.manager.execInContainer(
        binding.runtimeRef,
        ['python3', '-c', code, binding.stateRoot, ...args],
        { user: 'root' },
      );
      if (result.exitCode !== 0) throw new Error('managed-codex-channel-unavailable');
      return result.stdout;
    };
    const capability = await this.manager.execInContainer(
      binding.runtimeRef,
      ['codex', 'exec', '--help'],
      { user: 'root' },
    );
    if (
      capability.exitCode !== 0 ||
      !['--ephemeral', '--output-last-message', '--sandbox'].every((flag) =>
        capability.stdout.includes(flag),
      )
    )
      throw new Error('managed-codex-cli-incompatible');
    await exec(INSTALL, this.source, '180', this.worker);
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await exec(
        "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:4187/health',timeout=1).status)",
      ).catch(() => '');
      if (ready.trim() === '204') break;
      if (attempt === 29) throw new Error('managed-codex-channel-not-ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let stopped = false;
    let active = false;
    const poll = async () => {
      if (stopped || active) return;
      active = true;
      try {
        const raw = await exec(READ);
        if (!raw.trim() || stopped) return;
        const request = JSON.parse(raw) as { digest: string; body: string; ticket: string };
        if (
          typeof request.ticket !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(request.ticket) ||
          typeof request.body !== 'string' ||
          Buffer.byteLength(request.body) > 128 * 1024 ||
          request.digest !== sha256(request.body).slice(7)
        )
          throw new Error('managed-codex-request-invalid');
        codexInput(this.route, request.body);
        const response = await binding.invoke('codex-report-one', request.body, this.maximumTokens);
        if (stopped) return;
        await exec(
          WRITE,
          request.digest,
          String(response.state === 'observed'),
          response.state === 'observed' ? response.value : '',
          request.ticket,
        );
      } catch {
        // Never forward provider errors or worker payloads into logs.
        stopped = true;
        clearInterval(timer);
        await exec(
          "import pathlib,sys; (pathlib.Path(sys.argv[1])/'channel-closed').touch()",
        ).catch(() => {});
      } finally {
        active = false;
      }
    };
    const timer = setInterval(
      () => {
        void poll();
      },
      this.route.executionTarget === 'sandbox' ? 1000 : 100,
    );
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
      void exec("import pathlib,sys; (pathlib.Path(sys.argv[1])/'channel-closed').touch()").catch(
        () => {},
      );
    };
  }
}

/** Reviewed fixed command; the runtime appends the objective after --. */
export function codexReportCommand(route: Route, enrollmentId: string): readonly string[] {
  if (route.runtime !== 'codex' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(enrollmentId))
    throw new Error('managed-codex-command-binding');
  return [
    'python3',
    '/opt/dispatcher/codex_worker.py',
    '--model',
    route.model,
    '--reasoning',
    route.reasoning,
    '--readme',
    `/repositories/${enrollmentId}/README.md`,
    '--output',
    '/output/report.md',
  ];
}
