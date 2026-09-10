import { readFileSync } from 'node:fs';
import type { FollowUpEnvelope, ManagedPodRequest, Route } from '@autopod/shared';
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
if len(sys.argv)>5 and sys.argv[5]:
 gh=worker_root/'gh';gh.write_text(sys.argv[5]);os.chmod(gh,0o555);(root/'github-enabled').touch()
(root/'channel-closed').unlink(missing_ok=True)
with open(os.devnull,'wb') as sink: subprocess.Popen(['python3',str(file),str(root),'4187',sys.argv[3]],stdin=subprocess.DEVNULL,stdout=sink,stderr=sink,start_new_session=True)
`;
const READ = `import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);prefix=sys.argv[2];p=root/(prefix+'request.json');response=root/(prefix+'response.json')
if p.exists():
 if p.stat().st_size>270000: raise RuntimeError('size')
 request=json.loads(p.read_text())
 if not response.exists() or json.loads(response.read_text()).get('ticket')!=request['ticket']:print(p.read_text())
`;
const WRITE = `import json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);prefix=sys.argv[2];p=root/(prefix+'response.json');temp=root/(prefix+'response.tmp')
value={'digest':sys.argv[3],'ok':sys.argv[4]=='true','body':sys.argv[5],'ticket':sys.argv[6]}
request=json.loads((root/(prefix+'request.json')).read_text())
if request['ticket']!=value['ticket'] or request['digest']!=value['digest']:raise RuntimeError('delivery-binding')
if p.exists() and json.loads(p.read_text()).get('ticket')==value['ticket']:
 if json.loads(p.read_text())!=value:raise RuntimeError('replay-conflict')
else:
 with temp.open('w') as f:json.dump(value,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
 os.replace(temp,p)
`;
const SEND = `import json,os,pathlib,re,sys
root=pathlib.Path(sys.argv[1]);key=sys.argv[2];raw=sys.argv[3]
if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',key):raise RuntimeError('key')
value=json.loads(raw)
if not isinstance(value,dict) or set(value)!=set(['schemaVersion','dispatcherAttemptId','grantId','grantRevision','message']):raise RuntimeError('envelope')
p=root/('followup-'+key+'.json');temp=root/('followup-'+key+'.tmp')
if p.exists():
 if json.loads(p.read_text())!=value:raise RuntimeError('replay-conflict')
else:
 with temp.open('w') as f:json.dump(value,f,ensure_ascii=False,separators=(',',':'));f.flush();os.fsync(f.fileno())
 os.replace(temp,p)
`;
/** Concrete container loopback -> root spool -> trusted exec -> attempt gateway channel.
 * Container egress must be denied; it carries no worker-held auth secret.
 */
export class ContainerCodexChannel implements ManagedWorkerProviderChannel {
  private readonly route: Route;
  private readonly source: string;
  private readonly worker: string;
  private readonly githubCli: string;
  constructor(
    private readonly manager: ContainerManager,
    route: Route,
    private readonly maximumTokens: number,
    private readonly options: {
      mode?: 'report' | 'agent';
      maximumDurationSeconds?: number;
      githubRead?: { alias: string; bindingDigest: string };
    } = {},
  ) {
    this.route = structuredClone(route);
    this.source = readFileSync(new URL('./runtime/codex_channel.py', import.meta.url), 'utf8');
    this.worker = readFileSync(
      new URL(
        options.mode === 'agent' ? './runtime/codex_agent_worker.py' : './runtime/codex_worker.py',
        import.meta.url,
      ),
      'utf8',
    );
    this.githubCli = options.githubRead
      ? readFileSync(new URL('./runtime/github_cli.py', import.meta.url), 'utf8')
      : '';
    if (!Number.isSafeInteger(maximumTokens) || (maximumTokens !== 0 && maximumTokens < 2))
      throw new Error('managed-codex-budget-invalid');
  }
  async preflight(request: ManagedPodRequest) {
    if (canonical(this.route) !== canonical(request.route) || request.route.runtime !== 'codex')
      throw new Error('managed-codex-route-mismatch');
    if (
      request.effectiveGrant.scope.network.destinations.length ||
      ('maxTokens' in request.effectiveGrant.budget
        ? this.maximumTokens < 2 || this.maximumTokens >= request.effectiveGrant.budget.maxTokens
        : this.maximumTokens !== 0)
    )
      throw new Error('managed-codex-boundary-unavailable');
    const identities = request.effectiveGrant.scope.identityBindings;
    if (
      (identities.length > 0 || this.options.githubRead) &&
      (!this.options.githubRead ||
        identities.length !== 1 ||
        identities[0]?.alias !== this.options.githubRead.alias ||
        identities[0]?.bindingDigest !== this.options.githubRead.bindingDigest ||
        !request.effectiveGrant.scope.allowedEffects.includes('github.issue.read'))
    )
      throw new Error('managed-codex-identity-boundary-unavailable');
    const maximumDuration =
      this.options.mode === 'agent' ? (this.options.maximumDurationSeconds ?? 3600) : 180;
    if (request.effectiveGrant.budget.maxDurationSeconds > maximumDuration)
      throw new Error('managed-codex-canary-duration');
    if (this.options.mode !== 'agent' && request.outputs.source.mode !== 'none')
      throw new Error('managed-codex-report-only');
  }
  async send(runtimeRef: string, stateRoot: string, message: FollowUpEnvelope, key: string) {
    if (!/^\/run\/dispatcher-managed-[A-Za-z0-9-]+$/.test(stateRoot))
      throw new Error('managed-codex-follow-up-binding');
    const result = await this.manager.execInContainer(
      runtimeRef,
      ['python3', '-c', SEND, stateRoot, key, canonical(message)],
      { user: 'root' },
    );
    if (result.exitCode !== 0) throw new Error('managed-codex-follow-up-unavailable');
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
    const resumeCapability = await this.manager.execInContainer(
      binding.runtimeRef,
      ['codex', 'exec', 'resume', '--help'],
      { user: 'root' },
    );
    if (
      capability.exitCode !== 0 ||
      !['--output-last-message', '--sandbox'].every((flag) => capability.stdout.includes(flag)) ||
      resumeCapability.exitCode !== 0 ||
      !['--last', '--output-last-message'].every((flag) => resumeCapability.stdout.includes(flag))
    )
      throw new Error('managed-codex-cli-incompatible');
    await exec(
      INSTALL,
      this.source,
      String(this.options.mode === 'agent' ? (this.options.maximumDurationSeconds ?? 3600) : 180),
      this.worker,
      this.githubCli,
    );
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await exec(
        "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:4187/health',timeout=1).status)",
      ).catch(() => '');
      if (ready.trim() === '204') break;
      if (attempt === 29) throw new Error('managed-codex-channel-not-ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let stopped = false;
    let activeProvider = false;
    let activeGitHub = false;
    const poll = async () => {
      if (stopped || activeProvider) return;
      activeProvider = true;
      try {
        const raw = await exec(READ, 'channel-');
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
        codexInput(this.route, request.body, this.options.mode === 'agent');
        const operation =
          this.options.mode === 'agent' ? `codex-${request.digest}` : 'codex-report-one';
        const response = await binding.invoke(operation, request.body, this.maximumTokens);
        if (stopped) return;
        await exec(
          WRITE,
          'channel-',
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
        activeProvider = false;
      }
    };
    const pollGitHub = async () => {
      if (stopped || activeGitHub || !this.options.githubRead || !binding.invokeGitHub) return;
      activeGitHub = true;
      try {
        const raw = await exec(READ, 'github-');
        if (!raw.trim() || stopped) return;
        const request = JSON.parse(raw) as { digest: string; body: string; ticket: string };
        if (request.digest !== sha256(request.body).slice(7))
          throw new Error('managed-github-request-invalid');
        const value = await binding.invokeGitHub(`github-${request.digest}`, request.body);
        await exec(WRITE, 'github-', request.digest, 'true', value, request.ticket);
      } catch {
        stopped = true;
        clearInterval(timer);
      } finally {
        activeGitHub = false;
      }
    };
    const timer = setInterval(
      () => {
        void poll();
        void pollGitHub();
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

/** Reviewed full-agent command; mounts and grant determine read/write authority. */
export function codexAgentCommand(
  route: Route,
  enrollmentId: string,
  artifactPath: string,
  writable: boolean,
  inputNames: readonly string[] = [],
  githubRepository?: string,
): readonly string[] {
  if (
    route.runtime !== 'codex' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(enrollmentId) ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(artifactPath) ||
    inputNames.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) ||
    (githubRepository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository))
  )
    throw new Error('managed-codex-command-binding');
  const command = [
    'python3',
    '/opt/dispatcher/codex_worker.py',
    '--model',
    route.model,
    '--reasoning',
    route.reasoning,
    '--repository',
    `/repositories/${enrollmentId}`,
    '--output',
    `/output/${artifactPath}`,
    '--sandbox',
    writable ? 'workspace-write' : 'read-only',
  ];
  for (const name of inputNames) command.push('--input-root', `/inputs/${name}`);
  if (githubRepository) command.push('--github-repository', githubRepository);
  return command;
}

/** Reviewed fixed command; the runtime appends the objective after --. */
export function codexReportCommand(
  route: Route,
  enrollmentId: string,
  inputName?: string,
): readonly string[] {
  if (
    route.runtime !== 'codex' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(enrollmentId) ||
    (inputName !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(inputName))
  )
    throw new Error('managed-codex-command-binding');
  const command = [
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
  if (inputName !== undefined) command.push('--input-root', `/inputs/${inputName}`);
  return command;
}
