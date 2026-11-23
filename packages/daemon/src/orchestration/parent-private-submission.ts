import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonical, sha256 } from '../managed/canonical.js';
import { PRIVATE_SUBMISSION_MAX_BYTES } from '../managed/private-commit-policy.js';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import { managedGit, managedGitBytes } from '../managed/source-git.js';
import type { CandidatePathAllowance } from './candidate-path-scope.js';
import type { ContinuationCheckpoint } from './continuations.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';

const submission = z
  .object({
    version: z.literal(1),
    files: z
      .array(z.object({ path: z.string().max(256), content: z.string() }).strict())
      .min(1)
      .max(16),
  })
  .strict();

/** Only explicit plain-text replacements for enrolled files. No patch syntax, paths
 * from the workspace, filesystem traversal, deletions, or executable bit changes. */
function parseSubmission(raw: Buffer, scope: readonly CandidatePathAllowance[]) {
  if (!raw.length || raw.length > PRIVATE_SUBMISSION_MAX_BYTES)
    throw new Error('parent-private-submission-size');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new Error('parent-private-submission-invalid');
  }
  const parsed = submission.safeParse(decoded);
  if (!parsed.success) throw new Error('parent-private-submission-invalid');
  const seen = new Set<string>();
  for (const file of parsed.data.files) {
    if (
      !file.path
        .split('/')
        .every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith('.')) ||
      !scope.some((entry) => entry.kind === 'file' && entry.path === file.path) ||
      seen.has(file.path.toLowerCase()) ||
      file.content.includes('\0') ||
      Buffer.from(file.content).toString('utf8') !== file.content
    )
      throw new Error('parent-private-submission-scope');
    seen.add(file.path.toLowerCase());
  }
  return parsed.data.files;
}

/** Host-only construction from signed, retained seed custody in a temporary bare
 * mirror. The caller still verifies the resulting bundle and commits custody. */
export async function buildParentSubmissionHead(
  db: Database.Database,
  scratch: string,
  checkpoint: Readonly<ContinuationCheckpoint>,
  scope: readonly CandidatePathAllowance[],
  raw: Buffer,
  maxBytes: number,
  assertCurrent: () => void,
) {
  const files = parseSubmission(raw, scope);
  const { evidenceDigest, ...subject } = checkpoint;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > MAX_PRIVATE_HEAD_BYTES)
    throw new Error('parent-private-submission-bound');
  assertCurrent();
  const row = db
    .prepare(`SELECT manifest,bundle FROM orchestration_checkpoint_custody
    WHERE run_id=? AND evidence_digest=? AND length(bundle) BETWEEN 1 AND ?`)
    .get(subject.run, evidenceDigest, maxBytes) as { manifest: string; bundle: Buffer } | undefined;
  if (!row || sha256(row.manifest) !== evidenceDigest)
    throw new Error('checkpoint-custody-integrity');
  const manifest = JSON.parse(row.manifest);
  if (
    manifest.version !== 1 ||
    canonical(manifest.subject) !== canonical(subject) ||
    manifest.bundleDigest !== sha256(row.bundle)
  )
    throw new Error('checkpoint-custody-integrity');

  return withVerifiedCheckpointMirror(scratch, subject, row.bundle, async (mirror) => {
    assertCurrent();
    await managedGit(mirror, ['read-tree', subject.commit]);
    for (const { path, content } of files) {
      const existing = await managedGit(mirror, ['ls-tree', subject.commit, '--', path]);
      if (existing && !existing.startsWith('100644 blob '))
        throw new Error('parent-private-submission-file-type');
      const blob = (
        await managedGitBytes(mirror, ['hash-object', '-w', '--stdin'], undefined, [], {
          input: content,
          maxBuffer: 128,
          timeout: 3000,
        })
      )
        .toString('utf8')
        .trim();
      if (!/^[a-f0-9]{40}$/.test(blob)) throw new Error('parent-private-submission-object');
      await managedGit(mirror, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = await managedGit(mirror, ['write-tree']);
    if (tree === subject.tree) throw new Error('parent-private-submission-no-change');
    const commit = await managedGit(mirror, [
      '-c',
      'user.name=Autopod',
      '-c',
      'user.email=autopod@invalid.example',
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      tree,
      '-p',
      subject.commit,
      '-m',
      'Apply explicit managed worker submission',
    ]);
    if (![commit, tree].every((value) => /^[a-f0-9]{40}$/.test(value)))
      throw new Error('parent-private-submission-object');
    const header = Buffer.from(`# v2 git bundle\n${commit} HEAD\n\n`);
    const pack = await managedGitBytes(
      mirror,
      [
        '-c',
        'pack.threads=1',
        'pack-objects',
        '--revs',
        '--stdout',
        '--window=0',
        '--no-reuse-object',
        '--no-reuse-delta',
        '--no-use-bitmap-index',
      ],
      undefined,
      [],
      { input: `${commit}\n`, maxBuffer: maxBytes - header.length, timeout: 12_000 },
    );
    assertCurrent();
    return { commit, tree, bundle: Buffer.concat([header, pack]) };
  });
}
