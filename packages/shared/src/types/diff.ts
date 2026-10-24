export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  note?: string;
}

export interface DiffCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string;
  files: DiffFile[];
  stats: DiffStats;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

export interface DiffResponse {
  files: DiffFile[];
  stats: DiffStats;
  previewFiles: DiffFile[];
  previewStats: DiffStats;
  uncommittedFiles: DiffFile[];
  uncommittedStats: DiffStats;
  commits: DiffCommit[];
  commitGroupingUnavailableReason?: string;
}
