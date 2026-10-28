import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { sourceAdoptionError } from './source-adoption-identity.js';
import type {
  SourceAdoptionRecord,
  SourceAdoptionRepository,
} from './source-adoption-repository.js';
import { runSourceCommand } from './source-command-runner.js';
import { SOURCE_GIT_INSPECTION, parseInspectedSource } from './source-git-inspection.js';

const GIT_COMMAND = String.raw`
import os, sys
env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
env.update({'GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0','GIT_GRAFT_FILE':'/dev/null'})
os.execve('/usr/bin/git',['git','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','protocol.allow=never','-c','protocol.file.allow=always','-C','/workspace']+sys.argv[1:],env)
`;
const ASSEMBLE = String.raw`
import hashlib, pathlib, shutil, sys
root=pathlib.Path(sys.argv[1]); count=int(sys.argv[2]); expected=sys.argv[3]
if root.stat().st_mode & 0o777 != 0o700: raise RuntimeError('Source transfer namespace is not private')
with (root/'source.bundle').open('xb') as output:
    for number in range(count):
        with (root/('chunk-%04d'%number)).open('rb') as source:
            shutil.copyfileobj(source,output,1024*1024)
digest=hashlib.sha256()
with (root/'source.bundle').open('rb') as source:
    for chunk in iter(lambda: source.read(1024*1024),b''): digest.update(chunk)
if digest.hexdigest()!=expected: raise RuntimeError('Source transfer checksum mismatch')
`;

/** Real retained-resource adapter. No coding worker, network Git fetch, reset/clean or PID guessing. */
export function createSourceContainerAdoption(options: {
  record: SourceAdoptionRecord;
  journal: SourceAdoptionRepository;
  containerManager: ContainerManager;
  backend: 'docker' | 'sandbox';
  assertCurrent(): void;
}) {
  const { record, journal, containerManager: cm } = options;
  const check = options.assertCurrent;
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(record.id))
    sourceAdoptionError('Source transfer namespace invalid');
  const root = `/tmp/.autopod-source-${record.id}`;
  async function owned<T>(operation: () => Promise<T>): Promise<T> {
    check();
    try {
      const value = await operation();
      check();
      return value;
    } catch (error) {
      check();
      throw error;
    }
  }
  async function resource() {
    check();
    if (
      !cm.getResourceKey ||
      cm.supportsExecRecovery !== true ||
      cm.supportsStreamingExec === false
    )
      sourceAdoptionError('Exact recoverable source resource namespace unavailable');
    const key = await owned(() => cm.getResourceKey!(record.binding.containerId));
    if (key !== record.binding.resourceKey)
      sourceAdoptionError('Source resource namespace changed', 'SOURCE_RESOURCE_SUPERSEDED');
    const status = await owned(() => cm.getStatus(record.binding.containerId));
    if (status !== 'running')
      sourceAdoptionError(
        'Original source resource must be Running; adapter never resumes or replaces it',
        'VALIDATION_RESOURCE_UNAVAILABLE',
      );
  }
  async function command(step: string, argv: string[]) {
    await resource();
    return runSourceCommand({
      journal: journal.commands,
      adoptionId: record.id,
      step,
      backend: options.backend,
      containerId: record.binding.containerId,
      containerManager: cm,
      command: argv,
      assertCurrent: check,
    });
  }
  async function inspect(step: string) {
    const result = await command(step, [
      '/usr/bin/python3',
      '-I',
      '-c',
      SOURCE_GIT_INSPECTION,
      '/workspace',
      record.binding.branch,
    ]);
    return parseInspectedSource(result.stdout, record.binding.branch);
  }
  async function apply() {
    check();
    if (journal.get(record.id)?.stage !== 'applying' || !record.preservation)
      sourceAdoptionError('Source mutation has no preserved-workspace admission');
    const before = await inspect('container-before-apply');
    if (!before.worktreeClean || before.commitSha !== record.binding.oldHead)
      sourceAdoptionError('Original container source changed before fast-forward');
    await command('transfer-directory', [
      '/usr/bin/python3',
      '-I',
      '-c',
      'import os,sys; os.mkdir(sys.argv[1],0o700)',
      root,
    ]);
    const file = await owned(() => open(record.preservation!.bundle, 'r'));
    const digest = createHash('sha256');
    let count = 0;
    try {
      const size = (await owned(() => file.stat())).size;
      if (size <= 0 || size > 1_073_741_824)
        sourceAdoptionError('Source bundle exceeds bounded transfer limits');
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await owned(() => file.read(buffer, 0, buffer.length, null));
        if (!bytesRead) break;
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        digest.update(chunk);
        await resource();
        // Each acknowledged write is unique to this operation. A lost response
        // stops the workflow; it never retries/assembles over an uncertain write.
        await owned(() =>
          cm.writeFile(
            record.binding.containerId,
            `${root}/chunk-${String(count).padStart(4, '0')}`,
            chunk,
            {
              ...(options.backend === 'docker' ? { mode: 0o600 } : {}),
              timeoutMs: 30_000,
              preserveParentModes: true,
              singleAttempt: true,
              assertCurrent: check,
            },
          ),
        );
        count++;
        if (count > 1024) sourceAdoptionError('Source bundle grew during transfer');
      }
    } finally {
      await file.close();
    }
    if (digest.digest('hex') !== record.preservation.bundleHash)
      sourceAdoptionError('Saved source bundle changed during transfer');
    await command('assemble-bundle', [
      '/usr/bin/python3',
      '-I',
      '-c',
      ASSEMBLE,
      root,
      String(count),
      record.preservation.bundleHash,
    ]);
    await command('verify-bundle', [
      '/usr/bin/python3',
      '-I',
      '-c',
      GIT_COMMAND,
      'bundle',
      'verify',
      `${root}/source.bundle`,
    ]);
    await command('import-bundle', [
      '/usr/bin/python3',
      '-I',
      '-c',
      GIT_COMMAND,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      `${root}/source.bundle`,
      `refs/autopod/source-adoption/${record.id}/target`,
    ]);
    const original = await inspect('container-before-fast-forward');
    if (!original.worktreeClean || original.commitSha !== record.binding.oldHead)
      sourceAdoptionError('Container changed during source transfer');
    await command('fast-forward', [
      '/usr/bin/python3',
      '-I',
      '-c',
      GIT_COMMAND,
      'merge',
      '--ff-only',
      '--no-edit',
      '--no-stat',
      '--no-autostash',
      '--no-overwrite-ignore',
      record.binding.targetHead,
    ]);
    const after = await inspect('container-after-fast-forward');
    if (
      !after.worktreeClean ||
      after.commitSha !== record.binding.targetHead ||
      after.treeSha !== record.preservation.tree
    )
      sourceAdoptionError('Exact adopted container source could not be verified');
    journal.commands.assertSettled(record.id);
  }
  return { resource, inspect, apply };
}
