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
  /** Override the default auto-commit message. Defaults to a generic chore message. */
  commitMessage?: string;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface WorktreeResult {
  worktreePath: string;
  bareRepoPath: string;
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
   * Stage all changes and commit using a message generated from the staged diff
   * (Claude Haiku, with a heuristic fallback). Returns true if a commit was
   * created, false if the working tree was clean. The `podTask` is used as
   * extra context when generating the message.
   */
  commitPendingChangesWithGeneratedMessage(
    worktreePath: string,
    podTask: string | undefined,
    options?: { maxDeletions?: number },
  ): Promise<boolean>;
  /** Push the current branch to origin. Verifies HEAD is on `expectedBranch` before pushing. */
  pushBranch(worktreePath: string, expectedBranch: string): Promise<void>;
  /** Pull latest changes from origin for the current branch. */
  pullBranch(worktreePath: string): Promise<{ newCommits: boolean }>;
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
  /** Files under the path — only names ending in `.md`, recursive ONE level deep. */
  files: Array<{ filename: string; content: string }>;
  /** Contents of `context.md` at the path root, or '' if not present. */
  sharedContext: string;
}
