import Foundation

/// Response from GET /pods/:id/diff
public struct DiffApiResponse: Codable, Sendable {
  public let files: [DiffApiFile]
  public let stats: DiffApiStats
}

public struct DiffApiFile: Codable, Sendable {
  public let path: String
  public let status: String  // "added" | "modified" | "deleted"
  public let diff: String
}

public struct DiffApiStats: Codable, Sendable {
  public let added: Int
  public let removed: Int
  public let changed: Int
}
