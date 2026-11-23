import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryConfig } from '@autopod/shared';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import { canonical } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { withAnchoredBaseWorkspace } from './anchored-delegation-source.js';

const oid = /^[a-f0-9]{40}$/;
export const publishedBaseTransport = 'published-ref/v1' as const;

export interface PublishedBasePin {
  predecessor: string;
  commit: string;
  tree: string;
  ref: string;
  repositoryDigest: string;
}

/** Stored in SQLite instead of a full-history seed bundle. The object store
 * has its own retained ref; the reviewed descriptor cannot locate arbitrary paths. */
export function publishedSeedReceipt(pin: Readonly<PublishedBasePin>) {
  const { ref, repositoryDigest, commit, tree, predecessor } = pin;
  return Buffer.from(
    canonical({
      version: publishedBaseTransport,
      ref,
      repositoryDigest,
      commit,
      tree,
      predecessor,
    }),
  );
}

export function publishedDelegationSource(input: {
  mirror: string;
  scratch: string;
  github: DaemonGitHubAuth;
  readBranchHead(repository: RepositoryConfig, branch: string): Promise<string>;
  /** Trusted fetch port, defaulting to the daemon's restricted credentialed Git transport. */
  fetchBranch?: typeof managedGit;
}) {
  const { mirror, scratch } = input;
  if (!path.isAbsolute(mirror) || path.normalize(mirror) !== mirror)
    throw new Error('published-delegation-mirror-invalid');
  let tail: Promise<unknown> = Promise.resolve();
  const git = (args: string[]) => managedGit(mirror, args);
  const retained = (id: string) => `refs/autopod/retained/${id}`;
  async function prepare() {
    const parent = path.dirname(mirror);
    if ((await realpath(parent)) !== parent || (await lstat(parent)).mode & 0o022)
      throw new Error('published-delegation-mirror-parent-invalid');
    // Only the daemon writes this backing path. Evaluator identities receive
    // read-only access through site-managed mounts and permissions.
    const info = await lstat(mirror).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!info) {
      await mkdir(mirror, { mode: 0o750 });
      await git(['init', '--bare', '--template=', '--object-format=sha1']);
    }
    const dir = await lstat(mirror);
    if (
      !dir.isDirectory() ||
      dir.uid !== process.getuid?.() ||
      dir.mode & 0o022 ||
      (await realpath(mirror)) !== mirror ||
      (await git(['rev-parse', '--is-bare-repository'])) !== 'true'
    )
      throw new Error('published-delegation-mirror-invalid');
  }
  async function inspect(commit: string) {
    if (!oid.test(commit)) throw new Error('published-delegation-commit-invalid');
    const parentLine = (await git(['rev-list', '--parents', '-n1', commit])).split(' ');
    const tree = await git(['rev-parse', '--verify', `${commit}^{tree}`]);
    const predecessor = parentLine[1];
    if (parentLine[0] !== commit || !predecessor || !oid.test(predecessor) || !oid.test(tree))
      throw new Error('published-delegation-object-invalid');
    return { predecessor, commit, tree };
  }
  return {
    initialize: prepare,
    resolve(
      repository: RepositoryConfig,
      branch: string,
      repositoryDigest: string,
    ): Promise<PublishedBasePin> {
      const work = tail.then(async () => {
        if (
          repository.provider !== 'github' ||
          !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/)?$/.test(
            repository.remote,
          ) ||
          !branch.split('/').every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)) ||
          branch.includes('..')
        )
          throw new Error('published-delegation-source-invalid');
        const commit = await input.readBranchHead(repository, branch);
        if (!oid.test(commit)) throw new Error('published-delegation-commit-invalid');
        const ref = 'refs/heads/' + branch;
        await prepare();
        const found = await git(['rev-parse', '--verify', retained(commit)]).catch(() => undefined);
        if (found !== commit) {
          const remote = repository.remote.replace(/\/$/, '');
          const token = (await input.github.resolveCredential()).token;
          const staging = 'refs/autopod/staging';
          await (input.fetchBranch ?? managedGit)(
            mirror,
            [
              '-c',
              'fetch.fsckObjects=true',
              '-c',
              'core.fsync=committed',
              '-c',
              'gc.auto=0',
              'fetch',
              '--no-tags',
              '--no-recurse-submodules',
              '--no-auto-maintenance',
              '--no-write-fetch-head',
              '--',
              remote,
              `+${ref}:${staging}`,
            ],
            { url: remote, token, mode: 'github-basic' },
          );
          const actual = await git(['rev-parse', '--verify', staging]);
          if (actual !== commit) throw new Error('published-delegation-branch-moved');
          await inspect(commit);
          await git([
            '-c',
            'core.fsync=committed',
            'update-ref',
            retained(commit),
            commit,
            '0'.repeat(40),
          ]);
        }
        // A second authenticated observation also fences the cached-ref path.
        if ((await input.readBranchHead(repository, branch)) !== commit)
          throw new Error('published-delegation-branch-moved');
        return { ...(await inspect(commit)), ref, repositoryDigest };
      });
      tail = work.catch(() => {});
      return work;
    },
    async withBase<T>(pin: Readonly<PublishedBasePin>, use: (mirror: string) => Promise<T>) {
      if (
        !oid.test(pin.commit) ||
        (await git(['rev-parse', '--verify', retained(pin.commit)])) !== pin.commit
      )
        throw new Error('published-delegation-custody-unavailable');
      const found = await inspect(pin.commit);
      if (found.tree !== pin.tree || found.predecessor !== pin.predecessor)
        throw new Error('published-delegation-custody-mismatch');
      return withAnchoredBaseWorkspace(scratch, mirror, pin.commit, pin.tree, use);
    },
  };
}
