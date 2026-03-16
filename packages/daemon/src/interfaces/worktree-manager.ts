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
  getDiffStats(worktreePath: string): Promise<DiffStats>;
  mergeBranch(config: MergeBranchConfig): Promise<void>;
}
