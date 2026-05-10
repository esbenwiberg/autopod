import Foundation

/// Response from GET /pods/:id/files
public struct SessionFilesResponse: Codable, Sendable {
  public let files: [SessionFileEntry]
}

public struct SessionFileEntry: Codable, Sendable, Identifiable, Hashable {
  public var id: String { path }
  public let path: String
  public let size: Int
  public let modified: Double
}

/// Response from GET /pods/:id/files/content
public struct SessionFileContent: Codable, Sendable {
  public let path: String
  public let content: String
  public let size: Int
  /// "base64" when `content` is base64-encoded bytes (binary files like png/pdf).
  /// Absent for utf-8 text — clients should write `content` directly in that case.
  public let encoding: String?

  public init(path: String, content: String, size: Int, encoding: String? = nil) {
    self.path = path
    self.content = content
    self.size = size
    self.encoding = encoding
  }
}
