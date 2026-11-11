import Foundation

public struct RecoveryFileEntry: Codable, Identifiable, Sendable, Hashable {
  public var id: String { path }
  public let path: String
  public let size: Int
  public let modified: Double
  public let version: String
}
public struct RecoveryFileSource: Codable, Identifiable, Sendable {
  public enum Kind: String, Codable, Sendable { case saved, original }
  public enum Status: String, Codable, Sendable { case available, ready, stopped, blocked, unavailable }
  public let id: String
  public let kind: Kind
  public let label: String
  public let binding: String
  public let status: Status
  public let detail: String
  public let sandboxId: String?
  public let files: [RecoveryFileEntry]
  public let truncated: Bool
  public let skippedEntries: Int
}
public struct RecoveryFilesSnapshot: Codable, Sendable {
  public struct Limits: Codable, Sendable {
    public let maxFileBytes: Int
    public let maxSelectionBytes: Int
    public let maxFiles: Int
  }
  public let version: Int
  public let podId: String
  public let generation: Int
  public let sources: [RecoveryFileSource]
  public let limits: Limits
  public let excludes: [String]

  public func validate(podId: String) throws {
    guard version == 1, self.podId == podId, generation >= 0,
      (1...5 * 1024 * 1024).contains(limits.maxFileBytes),
      (1...50 * 1024 * 1024).contains(limits.maxSelectionBytes),
      (1...2000).contains(limits.maxFiles), sources.count <= 3,
      Set(sources.map(\.id)).count == sources.count else { throw URLError(.badServerResponse) }
    for source in sources {
      guard ["saved-workspace", "saved-artifacts", "original"].contains(source.id),
        (source.id == "original") == (source.kind == .original),
        ![.available, .ready].contains(source.status) || Self.isHash(source.binding),
        source.files.isEmpty || source.status == .available,
        source.files.count <= limits.maxFiles, source.skippedEntries >= 0,
        Set(source.files.map(\.path)).count == source.files.count,
        source.files.allSatisfy({ Self.safePath($0.path) && Self.isHash($0.version)
          && (0...limits.maxFileBytes).contains($0.size) && $0.modified.isFinite }) else {
        throw URLError(.badServerResponse)
      }
    }
  }
  public static func isHash(_ value: String) -> Bool {
    value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  public static func safePath(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 1024 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 || $0 == "\\" || $0 == ":" }
      && value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }
}
public struct RecoveryFileSelection: Codable, Sendable {
  public let sourceId: String
  public let binding: String
  public let generation: Int
  public let path: String
  public let version: String
  public init(source: RecoveryFileSource, generation: Int, file: RecoveryFileEntry) {
    sourceId = source.id; binding = source.binding; self.generation = generation
    path = file.path; version = file.version
  }
}
public struct RecoveryFileContent: Codable, Sendable {
  public let path: String
  public let content: String
  public let encoding: String
  public let size: Int
  public let sha256: String
}
