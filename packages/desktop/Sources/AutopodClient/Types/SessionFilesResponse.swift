import Foundation

/// Response from GET /sessions/:id/files
public struct SessionFilesResponse: Codable, Sendable {
  public let files: [SessionFileEntry]
}

public struct SessionFileEntry: Codable, Sendable, Identifiable, Hashable {
  public var id: String { path }
  public let path: String
  public let size: Int
  public let modified: Double
}

/// Response from GET /sessions/:id/files/content
public struct SessionFileContent: Codable, Sendable {
  public let path: String
  public let content: String
  public let size: Int
}
