import type { ContainerManager } from '../interfaces/container-manager.js';

export const MAX_PRIVATE_HEAD_BYTES = 1024 * 1024;
const COLLECT_HEAD = `import base64,os,re,resource,subprocess,sys,tempfile
root,raw_limit=sys.argv[1:];limit=int(raw_limit)
env={'PATH':'/usr/bin:/bin:/usr/local/bin','GIT_CONFIG_NOSYSTEM':'1',
     'GIT_CONFIG_GLOBAL':'/dev/null','GIT_NO_REPLACE_OBJECTS':'1',
     'GIT_OPTIONAL_LOCKS':'0','GIT_NO_LAZY_FETCH':'1','GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
git=['git','--git-dir='+root+'/.git','--work-tree='+root]
if os.geteuid()!=1000 or os.path.realpath(root)!=root:sys.exit(1)
if os.path.realpath(root+'/.git')!=root+'/.git' or not os.path.isdir(root+'/.git'):sys.exit(1)
def revision(arg):
 p=subprocess.run(git+['rev-parse','--verify',arg],env=env,timeout=3,
                  stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True)
 if not re.fullmatch(rb'[a-f0-9]{40}\\n',p.stdout):raise ValueError('invalid revision')
 return p.stdout[:-1]
try:
 commit=revision('HEAD^{commit}');tree=revision(commit.decode()+'^{tree}')
 header=b'# v2 git bundle\\n'+commit+b' HEAD\\n\\n'
 if limit<=len(header):sys.exit(1)
 resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
 with tempfile.TemporaryFile() as f:
  subprocess.run(git+['-c','pack.threads=1','pack-objects','--revs','--stdout','--window=0',
                 '--no-reuse-object','--no-reuse-delta','--no-use-bitmap-index'],
                 input=commit+b'\\n',stdout=f,stderr=subprocess.DEVNULL,env=env,timeout=12,check=True)
  f.seek(0);pack=f.read(limit+1)
 if len(header)+len(pack)>limit:sys.exit(1)
 sys.stdout.buffer.write(commit+b'\\n'+tree+b'\\n'+base64.b64encode(header+pack)+b'\\n')
except (OSError,subprocess.SubprocessError,ValueError):sys.exit(1)`;

export interface PrivateHeadExport {
  commit: string;
  tree: string;
  bundle: Buffer;
}

/** Fixed, unprivileged command; never sync a directory or take a caller-supplied path. */
export async function collectPrivateHead(
  manager: ContainerManager,
  runtimeRef: string,
  repository: string,
  maxBytes: number,
  assertCurrent: () => void,
): Promise<PrivateHeadExport> {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(repository) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_PRIVATE_HEAD_BYTES
  )
    throw new Error('parent-private-export-bound');
  const base64Cap = Math.ceil(maxBytes / 3) * 4;
  assertCurrent();
  const result = await manager.execInContainer(
    runtimeRef,
    ['python3', '-I', '-c', COLLECT_HEAD, `/repositories/${repository}`, String(maxBytes)],
    {
      user: 'autopod',
      timeout: 22_000,
      requireObservedExit: true,
      maxOutputBytes: 83 + base64Cap,
      assertCurrent,
    },
  );
  assertCurrent();
  if (result.exitCode !== 0 || result.stderr || result.stdout.length > 83 + base64Cap)
    throw new Error('parent-private-export-unverified');
  const [commit, tree, encoded, end, ...extra] = result.stdout.split('\n');
  if (
    !commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !tree ||
    !/^[a-f0-9]{40}$/.test(tree) ||
    !encoded ||
    encoded.length > base64Cap ||
    end !== '' ||
    extra.length
  )
    throw new Error('parent-private-export-unverified');
  const bundle = Buffer.from(encoded, 'base64');
  if (!bundle.length || bundle.length > maxBytes || bundle.toString('base64') !== encoded)
    throw new Error('parent-private-export-unverified');
  return { commit, tree, bundle };
}
