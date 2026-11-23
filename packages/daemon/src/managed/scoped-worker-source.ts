import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonical } from './canonical.js';
import { managedGit, managedGitBytes } from './source-git.js';

const oid = /^[a-f0-9]{40}$/;
const reserved = /^(?:node_modules|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const permittedPath = z
  .string()
  .max(160)
  .refine((file) =>
    file
      .split('/')
      .every(
        (part) =>
          /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith('.') && !reserved.test(part),
      ),
  );
const workerScope = z
  .array(z.object({ kind: z.literal('file'), path: permittedPath }).strict())
  .min(1)
  .max(16);
const context = ['AGENTS.md', 'CLAUDE.md', 'README.md'] as const;
const maxBytes = 1024 * 1024;

export interface ScopedWorkerSeed {
  tree: string;
  files: readonly string[];
}

/** Managed runtime input, never a wire parameter. It must agree with both the
 * saved continuation and the exact request durable before worker allocation. */
export function readSavedWorkerScope(
  db: Database.Database,
  binding: {
    podId: string;
    run: string;
    repository: string;
    commit: string;
    tree: string;
  },
  request: Readonly<ManagedPodRequest>,
): ScopedWorkerSeed {
  const row = db
    .prepare(`SELECT q.private_scope_json AS scope, c.request_json AS frozen,
    m.request_json AS admitted, m.execution_spec_digest AS spec
    FROM parent_managed_requests q
    JOIN saved_delegation_admissions a ON a.run_id=q.run_id
    JOIN orchestration_runs r ON r.id=q.run_id AND r.canceled=0
    JOIN parent_managed_sessions s ON s.run_id=q.run_id AND s.attempt=q.parent_attempt
    JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
    JOIN managed_pods m ON m.dispatcher_installation_id=('native.'||q.run_id)
      AND m.managed_start_key=q.start_key AND m.dispatcher_attempt_id=c.attempt_id
      AND m.revoked=0 AND m.stop_requested=0
    WHERE m.pod_id=? AND q.run_id=? AND q.start_key=? AND r.repository=? AND r.accepted_commit=?`)
    .get(binding.podId, binding.run, request.startKey, binding.repository, binding.commit) as
    | { scope: string; frozen: string; admitted: string; spec: string }
    | undefined;
  if (
    !row ||
    !row.scope ||
    !oid.test(binding.tree) ||
    row.spec !== request.executionSpecDigest ||
    canonical(JSON.parse(row.frozen)) !== canonical(request) ||
    canonical(JSON.parse(row.admitted)) !== canonical(request)
  )
    throw new Error('saved-worker-source-scope-unavailable');
  return {
    tree: binding.tree,
    files: workerScope.parse(JSON.parse(row.scope)).map((file) => file.path),
  };
}

/** Only paths authorized by the host plus fixed, optional root context. No
 * checkout, remotes, Git DB, generated files, or credentials enter this upload. */
export async function withScopedSandboxWorkerSource<T>(
  repo: string,
  commit: string,
  seed: ScopedWorkerSeed,
  use: (dir: string, manifest: string) => Promise<T>,
): Promise<T> {
  const assigned = workerScope
    .parse(seed.files.map((file) => ({ kind: 'file', path: file })))
    .map((file) => file.path);
  const tree = seed.tree;
  const paths = [...new Set([...assigned, ...context])].sort();
  const keys = paths.map((file) => file.toLowerCase());
  if (
    new Set(assigned).size !== assigned.length ||
    keys.some((file, i) =>
      keys.some((other, j) => i !== j && (other === file || other.startsWith(file + '/'))),
    )
  )
    throw new Error('saved-worker-source-scope-conflict');
  if (
    !oid.test(commit) ||
    !oid.test(tree) ||
    (await managedGit(repo, ['rev-parse', '--verify', `${commit}^{commit}`])) !== commit ||
    (await managedGit(repo, ['rev-parse', '--verify', `${commit}^{tree}`])) !== tree
  )
    throw new Error('saved-worker-source-pin-mismatch');
  const stage = await mkdtemp(path.join(path.dirname(repo), '.sandbox-scoped-source-'));
  const files: Record<string, string> = Object.create(null);
  const dirs = new Set(['.agents', '.codex']);
  let remaining = maxBytes;
  // --literal-pathspecs and an exact listing match prevent prefix/glob expansion.
  const list = (name: string) =>
    managedGitBytes(
      repo,
      ['--literal-pathspecs', 'ls-tree', '-l', '-z', commit, '--', name],
      undefined,
      [],
      {
        input: '',
        maxBuffer: 1024,
        timeout: 5000,
      },
    );
  const checkedParents = new Set<string>();
  try {
    for (const name of paths) {
      const line = await list(name);
      if (line.length) {
        const entry = /^100644 blob ([0-9a-f]{40}) +([0-9]+)\t([^\0]+)\0$/.exec(
          new TextDecoder('utf-8', { fatal: true }).decode(line),
        );
        if (!entry || entry[3] !== name) throw new Error('saved-worker-source-not-regular-file');
        const size = Number(entry[2]);
        if (!Number.isSafeInteger(size) || size < 0 || size > remaining)
          throw new Error('saved-worker-source-size');
        const bytes = await managedGitBytes(repo, ['cat-file', 'blob', entry[1]!], undefined, [], {
          input: '',
          maxBuffer: Math.max(1, size),
          timeout: 5000,
        });
        if (bytes.length !== size || bytes.includes(0))
          throw new Error('saved-worker-source-not-text');
        if (createHash('sha1').update(`blob ${size}\0`).update(bytes).digest('hex') !== entry[1])
          throw new Error('saved-worker-source-object-mismatch');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        remaining -= size;
        const file = path.join(stage, name);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        files[name] = createHash('sha256').update(bytes).digest('hex');
      }
      // An assigned but absent regular file is a legitimate creation scope.
      if (line.length || assigned.includes(name)) {
        for (
          let parent = path.posix.dirname(name);
          parent !== '.';
          parent = path.posix.dirname(parent)
        ) {
          dirs.add(parent);
          if (dirs.size > 256) throw new Error('saved-worker-source-directory-bound');
          if (!line.length && !checkedParents.has(parent)) {
            const item = await list(parent);
            if (item.length && !item.toString('ascii').startsWith('040000 tree '))
              throw new Error('saved-worker-source-parent-not-directory');
            checkedParents.add(parent);
          }
        }
      }
    }
    for (const dir of dirs) await mkdir(path.join(stage, dir), { recursive: true, mode: 0o700 });
    const manifest = JSON.stringify({ files, dirs: [...dirs].sort() });
    if (Buffer.byteLength(manifest) > 64 * 1024)
      throw new Error('saved-worker-source-manifest-bound');
    return await use(stage, manifest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
