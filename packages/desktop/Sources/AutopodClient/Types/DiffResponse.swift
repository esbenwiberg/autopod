import Foundation

/// Response from GET /pods/:id/diff
public struct DiffApiResponse: Codable, Sendable {
  public let files: [DiffApiFile]
  public let stats: DiffApiStats
  public let previewFiles: [DiffApiFile]?
  public let previewStats: DiffApiStats?
  public let uncommittedFiles: [DiffApiFile]?
  public let uncommittedStats: DiffApiStats?
  public let commits: [DiffApiCommit]?
  public let commitGroupingUnavailableReason: String?
}

public struct DiffApiFile: Codable, Sendable {
  public let path: String
  public let status: String  // "added" | "modified" | "deleted"
  public let diff: String
  public let binary: Bool?
  public let truncated: Bool?
  public let note: String?
}

public struct DiffApiStats: Codable, Sendable {
  public let added: Int
  public let removed: Int
  public let changed: Int
}

public struct DiffApiCommit: Codable, Sendable {
  public let sha: String
  public let shortSha: String
  public let subject: String
  public let body: String
  public let authorDate: String
  public let files: [DiffApiFile]
  public let stats: DiffApiStats
}
