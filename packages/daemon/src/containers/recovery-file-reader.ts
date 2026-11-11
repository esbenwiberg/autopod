import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  RECOVERY_FILE_EXCLUDES,
  RECOVERY_FILE_LIMITS,
  type RecoveryFileContent,
  type RecoveryFileListing,
  recoveryFileError,
  safeRecoveryPath,
} from '../interfaces/recovery-files.js';

// Isolated Python stdlib, descriptor-relative O_NOFOLLOW at EVERY path component.
// No workspace imports, shell interpolation, writes, wakeups or agent commands.
// Shared by host and sandbox so binary/path/race/limit semantics cannot diverge.
export const RECOVERY_FILE_READER = String.raw`
import os, sys, json, stat, hashlib, base64
mode, root, relative, expected, root_id = sys.argv[1:6]
policy = json.loads(sys.argv[6]); limits = policy['limits']; excludes = policy['excludes']
def safe(p):
    return 0 < len(p.encode('utf-8')) <= 1024 and not any(ord(c)<32 or ord(c)==127 or c in '\\:' for c in p) and all(
      s not in ('', '.', '..') and not any(s.startswith(x[:-1]) if x.endswith('*') else s==x for x in excludes) for s in p.split('/'))
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
rootfd = os.open(root, flags | os.O_DIRECTORY)
identity = '%s:%s' % (os.fstat(rootfd).st_dev, os.fstat(rootfd).st_ino)
if root_id and identity != root_id: raise RuntimeError('root changed')
def version(s):
    return hashlib.sha256(json.dumps([identity, str(s.st_dev), str(s.st_ino), s.st_size, str(s.st_mtime_ns), str(s.st_ctime_ns)], separators=(',',':')).encode()).hexdigest()
try:
    if mode == 'list':
        files=[]; skipped=0; visited=0; truncated=False
        def walk(fd, prefix, depth):
            global skipped, visited, truncated
            with os.scandir(fd) as entries:
                for e in entries:
                    visited+=1
                    if visited > limits['maxVisited'] or len(files)>=limits['maxFiles']:
                        truncated=True; return
                    p=prefix+e.name
                    if not safe(p): skipped+=1; continue
                    try:
                        s=e.stat(follow_symlinks=False)
                        if stat.S_ISDIR(s.st_mode):
                            if depth>=limits['maxDepth']: truncated=True; skipped+=1; continue
                            child=os.open(e.name, flags | os.O_DIRECTORY, dir_fd=fd)
                            try: walk(child,p+'/',depth+1)
                            finally: os.close(child)
                        elif stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=limits['maxFileBytes']:
                            files.append({'path':p,'size':s.st_size,'modified':s.st_mtime*1000,'version':version(s)})
                        else: skipped+=1
                    except OSError: skipped+=1
                    if truncated and (visited>limits['maxVisited'] or len(files)>=limits['maxFiles']): return
        walk(rootfd,'',0)
        print(json.dumps({'files':sorted(files,key=lambda f:f['path']),'truncated':truncated,'skippedEntries':skipped}))
    elif mode == 'read' and safe(relative):
        fd=os.dup(rootfd)
        try:
            parts=relative.split('/')
            for part in parts[:-1]:
                nextfd=os.open(part,flags | os.O_DIRECTORY,dir_fd=fd); os.close(fd); fd=nextfd
            filefd=os.open(parts[-1],flags,dir_fd=fd)
            try:
                before=os.fstat(filefd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limits['maxFileBytes'] or version(before)!=expected:
                    raise RuntimeError('file changed or unsupported')
                chunks=[]; remaining=limits['maxFileBytes']+1
                while remaining:
                    chunk=os.read(filefd,min(65536,remaining))
                    if not chunk: break
                    chunks.append(chunk); remaining-=len(chunk)
                data=b''.join(chunks)
                if len(data)!=before.st_size or len(data)>limits['maxFileBytes'] or version(os.fstat(filefd))!=expected:
                    raise RuntimeError('file changed during read')
                print(json.dumps({'path':relative,'size':len(data),'encoding':'base64','content':base64.b64encode(data).decode('ascii'),'sha256':hashlib.sha256(data).hexdigest()}))
            finally: os.close(filefd)
        finally: os.close(fd)
    else: raise RuntimeError('invalid file request')
finally: os.close(rootfd)
`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const entry = z.object({
  path: z.string().refine(safeRecoveryPath),
  size: z.number().int().min(0).max(RECOVERY_FILE_LIMITS.maxFileBytes),
  modified: z.number().finite(),
  version: hash,
});
const listing = z.object({
  files: z.array(entry).max(RECOVERY_FILE_LIMITS.maxFiles),
  truncated: z.boolean(),
  skippedEntries: z.number().int().min(0),
});
const content = z.object({
  path: z.string().refine(safeRecoveryPath),
  size: z.number().int().min(0).max(RECOVERY_FILE_LIMITS.maxFileBytes),
  encoding: z.literal('base64'),
  content: z.string().max(7 * 1024 * 1024),
  sha256: hash,
});
export function recoveryReaderArgs(
  mode: 'list' | 'read',
  root: string,
  relative = '',
  version = '',
  rootIdentity = '',
): string[] {
  if (mode === 'read' && (!safeRecoveryPath(relative) || !hash.safeParse(version).success))
    recoveryFileError();
  return [
    'python3',
    '-I',
    '-S',
    '-c',
    RECOVERY_FILE_READER,
    mode,
    root,
    relative,
    version,
    rootIdentity,
    JSON.stringify({ limits: RECOVERY_FILE_LIMITS, excludes: RECOVERY_FILE_EXCLUDES }),
  ];
}
export function parseRecoveryListing(stdout: string): RecoveryFileListing {
  const value = listing.parse(JSON.parse(stdout));
  if (new Set(value.files.map((f) => f.path)).size !== value.files.length) recoveryFileError();
  return value;
}
export function parseRecoveryContent(stdout: string, relative: string): RecoveryFileContent {
  const value = content.parse(JSON.parse(stdout));
  const bytes = Buffer.from(value.content, 'base64');
  if (
    value.path !== relative ||
    bytes.length !== value.size ||
    bytes.toString('base64') !== value.content ||
    createHash('sha256').update(bytes).digest('hex') !== value.sha256
  )
    recoveryFileError();
  return value;
}
export async function runHostRecoveryReader(args: string[]): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(args[0]!, args.slice(1), {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: '/',
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return recoveryFileError(
      'File inspection unavailable. Python 3 is required; no environment was started and no source fallback was used.',
    );
  }
}
