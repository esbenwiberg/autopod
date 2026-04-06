export interface WorktreeCreateConfig {
  repoUrl: string;
  branch: string;
  baseBranch: string;
  /** PAT used for authenticated clone/fetch/push on the daemon host. Never written to git remote config. */
  pat?: string;
}

export interface MergeBranchConfig {
  worktreePath: string;
  targetBranch: string;
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
  getDiffStats(worktreePath: string, baseBranch?: string): Promise<DiffStats>;
  mergeBranch(config: MergeBranchConfig): Promise<void>;
  /** Get raw diff between current HEAD and a base branch. */
  getDiff(worktreePath: string, baseBranch: string, maxLength?: number): Promise<string>;
  /** Stage and commit specific paths (e.g. screenshot artifacts). No-op if nothing to commit. */
  commitFiles(worktreePath: string, paths: string[], message: string): Promise<void>;
  /** Stage all changes and commit. Returns true if a commit was created, false if working tree was clean. */
  commitPendingChanges(worktreePath: string, message: string): Promise<boolean>;
  /** Push the current branch to origin. */
  pushBranch(worktreePath: string): Promise<void>;
  /** Pull latest changes from origin for the current branch. */
  pullBranch(worktreePath: string): Promise<{ newCommits: boolean }>;
  /** Get commit log between current HEAD and a base branch (one-line format). */
  getCommitLog(worktreePath: string, baseBranch: string, maxCommits?: number): Promise<string>;
}
