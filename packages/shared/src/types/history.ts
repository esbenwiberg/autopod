export interface HistoryQuery {
  repositoryId?: string;
  profileName?: string;
  since?: string;
  limit?: number;
  failuresOnly?: boolean;
}

export interface HistoryExportStats {
  totalSessions: number;
  byStatus: Record<string, number>;
  totalCost: number;
}
