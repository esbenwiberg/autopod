import { sourceAdoptionError } from './source-adoption-identity.js';

/** Fixed, isolated interpreter + system Git: no shell interpolation or repository Python imports. */
export const SOURCE_GIT_INSPECTION = String.raw`
import json, os, subprocess, sys
env = {key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
env.update({'GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0','GIT_GRAFT_FILE':'/dev/null'})
base = ['/usr/bin/git','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-C',sys.argv[1]]
def git(*args):
    return subprocess.check_output(base+list(args),env=env).decode('utf-8')
# Refuse executable filters/submodule configuration BEFORE status can invoke it.
filters=subprocess.run(base+['config','--get-regexp','^filter\\.'],env=env,capture_output=True)
if filters.returncode != 1:
    raise RuntimeError('Repository filters need explicit source materialization policy')
sparse=subprocess.run(base+['config','--bool','core.sparseCheckout'],env=env,capture_output=True)
if sparse.returncode not in (0,1) or sparse.stdout.strip()==b'true':
    raise RuntimeError('Sparse checkout configuration needs explicit source materialization')
branch=git('symbolic-ref','--short','HEAD').strip()
head=git('rev-parse','HEAD').strip()
tree=git('rev-parse',head+'^{tree}').strip()
if any(line.startswith('160000 ') for line in git('ls-tree','-r',head).splitlines()) or any(line.startswith('160000 ') for line in git('ls-files','--stage').splitlines()):
    raise RuntimeError('Submodules need recursive source custody')
entries=git('ls-files','-v','-z').split('\0')
if branch != sys.argv[2] or any(entry and (entry[0].islower() or entry[0]=='S') for entry in entries):
    raise RuntimeError('Branch or hidden/sparse index flags require source reconciliation')
status=git('status','--porcelain=v1','-z','--untracked-files=normal','--ignore-submodules=none')
if git('rev-parse','HEAD').strip()!=head or git('symbolic-ref','--short','HEAD').strip()!=branch:
    raise RuntimeError('Source changed during inspection')
print(json.dumps({'branch':branch,'commitSha':head,'treeSha':tree,'worktreeClean':not bool(status)}))
`;
export interface InspectedSource {
  branch: string;
  commitSha: string;
  treeSha: string;
  worktreeClean: boolean;
}
export function parseInspectedSource(encoded: string, branch: string): InspectedSource {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    sourceAdoptionError('Malformed source inspection response', 'SOURCE_IDENTITY_UNAVAILABLE');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('branch' in value) ||
    value.branch !== branch ||
    !('commitSha' in value) ||
    typeof value.commitSha !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commitSha) ||
    !('treeSha' in value) ||
    typeof value.treeSha !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.treeSha) ||
    !('worktreeClean' in value) ||
    typeof value.worktreeClean !== 'boolean'
  )
    sourceAdoptionError(
      'Source inspection is not an exact branch/commit/tree identity',
      'SOURCE_IDENTITY_UNAVAILABLE',
    );
  return {
    branch,
    commitSha: value.commitSha,
    treeSha: value.treeSha,
    worktreeClean: value.worktreeClean,
  };
}
