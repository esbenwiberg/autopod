export interface WorktreeCreateConfig {
  repoUrl: string;
  branch: string;
  baseBranch: string;
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

export interface WorktreeManager {
  create(config: WorktreeCreateConfig): Promise<string>; // returns worktreePath
  cleanup(worktreePath: string): Promise<void>;
  getDiffStats(worktreePath: string, baseBranch?: string): Promise<DiffStats>;
  mergeBranch(config: MergeBranchConfig): Promise<void>;
  /** Get raw diff between current HEAD and a base branch. */
  getDiff(worktreePath: string, baseBranch: string, maxLength?: number): Promise<string>;
  /** Stage and commit specific paths (e.g. screenshot artifacts). No-op if nothing to commit. */
  commitFiles(worktreePath: string, paths: string[], message: string): Promise<void>;
}
