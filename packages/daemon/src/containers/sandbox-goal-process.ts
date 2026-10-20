import { createHash } from 'node:crypto';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import { z } from 'zod';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Agent environment is delivered to the child, never to the privileged interpreter. */
export const SANDBOX_GOAL_SUPERVISOR_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/root',
  USER: 'root',
  LOGNAME: 'root',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  LD_PRELOAD: '',
  LD_LIBRARY_PATH: '',
  LD_AUDIT: '',
  GLIBC_TUNABLES: '',
  GCONV_PATH: '',
  LOCPATH: '',
  PYTHONPATH: '',
  PYTHONHOME: '',
  PYTHONUSERBASE: '',
  PYTHONSTARTUP: '',
  ENV: '',
  BASH_ENV: '',
};

export function sandboxGoalProcess(containerId: string, execId: string): NativeGoalProcessIdentity {
  if (!containerId || !uuid.test(execId)) throw new Error('Invalid sandbox Goal identity');
  return {
    backend: 'sandbox',
    containerId,
    execId,
    pidPath: `/run/autopod-goal-exec-${execId}/state.json`,
  };
}

export function sandboxGoalRoot(identity: NativeGoalProcessIdentity): string {
  const expected = sandboxGoalProcess(identity.containerId, identity.execId);
  if (identity.backend !== 'sandbox' || identity.pidPath !== expected.pidPath)
    throw new Error('Invalid recorded sandbox Goal identity');
  return identity.pidPath.slice(0, -'/state.json'.length);
}

/** The non-TTY Azure stream closes stdin. Use ordered, private, complete input packets. */
export function sandboxGoalInput(
  identity: NativeGoalProcessIdentity,
  sequence: number,
  data: Buffer,
): { path: string; content: Buffer } {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || data.length > 2 * 1024 * 1024)
    throw new Error('Invalid sandbox Goal input packet');
  return {
    path: `${sandboxGoalRoot(identity)}/input-${sequence}.json`,
    content: Buffer.from(
      JSON.stringify({
        sequence,
        data: data.toString('base64'),
        length: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }),
    ),
  };
}

const receipt = z.object({
  execId: z.string(),
  observedExit: z.boolean(),
  exitCode: z.number().int().min(-127).max(255).optional(),
});

export function sandboxGoalExit(identity: NativeGoalProcessIdentity, raw: string): number | null {
  const value = receipt.parse(JSON.parse(raw));
  if (value.execId !== identity.execId) throw new Error('Sandbox Goal process ownership changed');
  if (!value.observedExit) return null;
  if (value.exitCode === undefined) throw new Error('Sandbox Goal process exit is unconfirmed');
  // Python reports signal termination as -signal; ContainerManager uses shell exit codes.
  return value.exitCode < 0 ? 128 - value.exitCode : value.exitCode;
}

/** Root-owned claim/exit receipts survive a lost WebSocket and cannot be written by the agent. */
export function sandboxGoalSupervisor(
  identity: NativeGoalProcessIdentity,
  command: string[],
  cwd?: string,
  environment?: Record<string, string>,
  stdin = false,
): string {
  const spec = Buffer.from(
    JSON.stringify({
      root: sandboxGoalRoot(identity),
      execId: identity.execId,
      command,
      cwd,
      environment,
      stdin,
    }),
  ).toString('base64');
  return `#!/usr/bin/python3 -I
import base64,binascii,fcntl,hashlib,json,os,pathlib,signal,subprocess,sys,time
spec=json.loads(base64.b64decode('${spec}'))
root=pathlib.Path(spec['root'])
if os.geteuid()!=0 or root.is_symlink() or root.stat().st_uid!=0 or root.stat().st_mode & 0o077:
    raise RuntimeError('private-supervisor-required')
def publish(value):
    temp=root/'state.tmp'
    with os.fdopen(os.open(temp,os.O_CREAT|os.O_TRUNC|os.O_WRONLY|os.O_NOFOLLOW,0o600),'w') as f:
        json.dump({'execId':spec['execId'],**value},f);f.flush();os.fsync(f.fileno())
    os.replace(temp,root/'state.json')
if '--cancel' in sys.argv:
    (root/'stop').touch(mode=0o600)
lock=(root/'lock').open('a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:sys.exit(0)
state=root/'state.json'
if state.exists():
    # A claim with no exit receipt is uncertain, never permission to launch again.
    sys.exit(0)
if (root/'stop').exists():
    publish({'observedExit':True,'exitCode':0});sys.exit(0)
publish({'observedExit':False})
def isolate():
    os.setsid()
    if sys.platform=='linux':
        import ctypes
        if ctypes.CDLL(None).prctl(38,1,0,0,0)!=0:raise RuntimeError('no-new-privileges')
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
def alive(group):
    if sys.platform=='linux':
        for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
            try:
                fields=path.read_text().rsplit(') ',1)[1].split()
                if int(fields[2])==group and fields[0]!='Z':return True
            except (FileNotFoundError,ProcessLookupError):pass
        return False
    try:os.killpg(group,0);return True
    except ProcessLookupError:return False
def send(group,sig):
    try:os.killpg(group,sig)
    except ProcessLookupError:pass
def stop(*_):
    (root/'stop').touch(mode=0o600)
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
env={**os.environ,**(spec.get('environment') or {}),'HOME':'/home/autopod','USER':'autopod','LOGNAME':'autopod'}
try:
    child=subprocess.Popen(spec['command'],cwd=spec.get('cwd') or '/',env=env,preexec_fn=isolate,stdin=subprocess.PIPE if spec['stdin'] else None)
except Exception:
    publish({'observedExit':True,'exitCode':127});raise
pending=bytearray();input_index=1;input_open=bool(child.stdin)
if input_open:os.set_blocking(child.stdin.fileno(),False)
def pump_input():
    global input_index,input_open
    if not input_open:return
    path=root/('input-'+str(input_index)+'.json')
    try:
        # The files endpoint may expose an upload before it finishes. Never forward partial input.
        if path.stat().st_size<=3*1024*1024:
            packet=json.loads(path.read_bytes())
            data=base64.b64decode(packet['data'],validate=True)
            if packet['sequence']==input_index and len(data)==packet['length'] and len(data)<=2*1024*1024 and hashlib.sha256(data).hexdigest()==packet['sha256'] and len(pending)+len(data)<=8*1024*1024:
                pending.extend(data);path.unlink();input_index+=1
    except (FileNotFoundError,ValueError,KeyError,TypeError,binascii.Error):pass
    if pending:
        try:
            written=os.write(child.stdin.fileno(),pending)
            del pending[:written]
        except BlockingIOError:pass
        except BrokenPipeError:
            input_open=False;pending.clear();child.stdin.close()
while child.poll() is None:
    if (root/'stop').exists():
        send(child.pid,signal.SIGTERM)
        try:child.wait(timeout=1)
        except subprocess.TimeoutExpired:send(child.pid,signal.SIGKILL);child.wait(timeout=1)
        break
    pump_input()
    time.sleep(0.05)
send(child.pid,signal.SIGKILL)
deadline=time.monotonic()+2
while alive(child.pid) and time.monotonic()<deadline:time.sleep(0.05)
if alive(child.pid):raise RuntimeError('termination-unconfirmed')
publish({'observedExit':True,'exitCode':child.returncode})
sys.exit(child.returncode if child.returncode>=0 else 128-child.returncode)
`;
}
