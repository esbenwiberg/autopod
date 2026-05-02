export interface WorktreeCreateConfig {
  repoUrl: string;
  branch: string;
  baseBranch: string;
  /** PAT used for authenticated clone/fetch/push on the daemon host. Never written to git remote config. */
  pat?: string;
  /** ID used to derive the worktree directory path. Defaults to a sanitized form of the branch name. Pass pod ID to ensure uniqueness when multiple pods share the same branch (e.g. single-mode series). */
  sessionId?: string;
}

export interface MergeBranchConfig {
  worktreePath: string;
  targetBranch: string;
  /** PAT to use for the push — overrides the in-memory cache. Required when the cache may be cold (e.g. after a daemon restart). */
  pat?: string;
  /**
   * Maximum number of files that may be staged for deletion during the internal auto-commit.
   * Defaults to 100. Pass 0 when the worktree may be out of sync with the container (sync-back
   * failed or wasn't attempted) so a ghost mass-deletion does not get committed over real work.
   */
  maxDeletions?: number;
  /**
   * Override the default auto-commit message. When omitted, the message is
   * generated from the staged diff using the profile's provider+model (with a
   * heuristic fallback when the provider can't be called from the daemon).
   */
  commitMessage?: string;
  /**
   * Pod task description, used as extra context when auto-generating the
   * commit message. Ignored when `commitMessage` is provided.
   */
  podTask?: string;
  /** Pod's profile — drives daemon-side LLM auth for the auto-commit message. */
  profile?: import('@autopod/shared').Profile;
  /** Pod's model id (e.g. 'haiku', 'sonnet', 'opus'). */
  podModel?: string;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface RebaseOntoBaseConfig {
  worktreePath: string;
  baseBranch: string;
  /** PAT for the fetch — required when the in-memory cache may be cold (post-restart). */
  pat?: string;
}

export interface RebaseOntoBaseResult {
  /** True when origin/<baseBranch> is already an ancestor of HEAD; no rebase performed. */
  alreadyUpToDate: boolean;
  /** True when a rebase replayed cleanly (or was unnecessary). False on conflict. */
  rebased: boolean;
  /** Files with conflict markers when the rebase aborts. Empty when rebased=true. */
  conflicts: string[];
}

export interface WorktreeResult {
  worktreePath: string;
  bareRepoPath: string;
  /**
   * SHA of HEAD immediately after the worktree was created (i.e. the resolved
   * `startPoint`). Persist this on the pod row so the diff route has a stable
   * base from the moment provisioning completes — eliminates a race where the
   * diff endpoint falls back to merge-base-with-baseBranch and surfaces the
   * entire PR's prior commits as the fix pod's "work".
   */
  startCommitSha: string;
}

export interface WorktreeManager {
  create(config: WorktreeCreateConfig): Promise<WorktreeResult>;
  cleanup(worktreePath: string): Promise<void>;
  getDiffStats(worktreePath: string, baseBranch?: string, sinceCommit?: string): Promise<DiffStats>;
  mergeBranch(config: MergeBranchConfig): Promise<void>;
  /** Get raw diff between current HEAD and a base branch (or a specific commit). */
  getDiff(
    worktreePath: string,
    baseBranch: string,
    maxLength?: number,
    sinceCommit?: string,
  ): Promise<string>;
  /** Stage and commit specific paths (e.g. screenshot artifacts). No-op if nothing to commit. */
  commitFiles(worktreePath: string, paths: string[], message: string): Promise<void>;
  /** Stage all changes and commit. Returns true if a commit was created, false if working tree was clean. */
  commitPendingChanges(
    worktreePath: string,
    message: string,
    options?: { maxDeletions?: number },
  ): Promise<boolean>;
  /**
   * Stage all changes and commit using a message generated from the staged
   * diff via the profile's provider+model (with a heuristic fallback when the
   * provider can't be called from the daemon). Returns true if a commit was
   * created, false if the working tree was clean. The `podTask` is used as
   * extra context when generating the message.
   */
  commitPendingChangesWithGeneratedMessage(
    worktreePath: string,
    podTask: string | undefined,
    profile: import('@autopod/shared').Profile,
    podModel: string,
    options?: { maxDeletions?: number },
  ): Promise<boolean>;
  /** Push the current branch to origin. Verifies HEAD is on `expectedBranch` before pushing. */
  pushBranch(
    worktreePath: string,
    expectedBranch: string,
    options?: { force?: boolean },
  ): Promise<void>;
  /** Pull latest changes from origin for the current branch. */
  pullBranch(worktreePath: string): Promise<{ newCommits: boolean }>;
  /**
   * Fetch latest origin/<baseBranch> and rebase the current branch onto it.
   *
   * Returns:
   *   - alreadyUpToDate=true → branch already includes origin/baseBranch tip; no-op
   *   - rebased=true        → rebase replayed cleanly; HEAD now sits on top of latest base
   *   - conflicts.length>0  → rebase aborted; worktree restored to pre-rebase state
   *
   * Never throws on conflicts — always returns a structured result so callers
   * can route to a fix pod or the merge_pending state without try/catch.
   */
  rebaseOntoBase(config: RebaseOntoBaseConfig): Promise<RebaseOntoBaseResult>;
  /** Get commit log between current HEAD and a base branch (or a specific commit). */
  getCommitLog(
    worktreePath: string,
    baseBranch: string,
    maxCommits?: number,
    sinceCommit?: string,
  ): Promise<string>;
  /**
   * Read all `.md` files under a relative path on a given branch, without
   * creating a full worktree. Used by the Create Series sheet to preview
   * brief folders that live on the branch (produced by `/prep` or an
   * interactive pod). The `pat` is used for the underlying fetch only.
   */
  readBranchFolder(params: {
    repoUrl: string;
    branch: string;
    relPath: string;
    pat?: string;
  }): Promise<BranchFolderContents>;
}

export interface BranchFolderContents {
  /** The relative path that was read (normalized). */
  relPath: string;
  /** Brief files under the path's `briefs/` subfolder (or the path itself if flat). */
  files: Array<{ filename: string; content: string }>;
  /** Contents of `purpose.md` at the spec root, or '' if not present. */
  purposeMd: string;
  /** Contents of `design.md` at the spec root, or '' if not present. */
  designMd: string;
}
