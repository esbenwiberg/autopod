import Foundation

public struct SavedWorkSource: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: String
  public let commit: String
  public let tree: String
  public let parent: String?
  public let parentTree: String?
  public let ref: String
  public let capturedAt: String?
  public let freshness: String
  public let exclusions: String
}
public struct SavedWorkDraftPrepare: Codable, Sendable, Equatable {
  public let requestId: String
  public let expectedBinding: String
  public let sourceId: String
  public init(requestId: String, expectedBinding: String, sourceId: String) {
    self.requestId = requestId; self.expectedBinding = expectedBinding; self.sourceId = sourceId
  }
}
public struct SavedWorkDraftConfirm: Codable, Sendable, Equatable {
  public let requestId: String
  public let expectedBinding: String
  public let draftOnly: Bool
  public init(requestId: String, expectedBinding: String) {
    self.requestId = requestId; self.expectedBinding = expectedBinding; draftOnly = true
  }
}
public struct SavedWorkDraftCancel: Codable, Sendable, Equatable {
  public let requestId: String
  public let expectedBinding: String
  public init(requestId: String, expectedBinding: String) {
    self.requestId = requestId; self.expectedBinding = expectedBinding
  }
}
public struct SavedWorkDraftPreparationCancellation: Codable, Sendable, Equatable {
  public let requestId: String
  public let expectedBinding: String
  public let sourceId: String
  public let podId: String
  public let actorId: String
  public let state: String
}
public struct SavedWorkDraftOperation: Codable, Sendable, Equatable {
  public struct Receipt: Codable, Sendable, Equatable {
    public let url: String
    public let draft: Bool
    public let head: String
    public let baseBranch: String
    public let branch: String
  }
  public let id: String
  public let requestId: String
  public let podId: String
  public let actorId: String
  public let generation: Int
  public let previewBinding: String
  public let confirmationBinding: String
  public let repository: String
  public let baseBranch: String
  public let branch: String
  public let source: SavedWorkSource
  public let checks: String
  public let body: String
  public let createdAt: String
  public let expiresAt: String
  public let state: String
  public let message: String?
  public let receipt: Receipt?
  public var safeDraftURL: URL? {
    guard state == "published", let receipt, receipt.draft,
      receipt.head == source.commit, receipt.branch == branch, receipt.baseBranch == baseBranch,
      let expected = Self.repositoryIdentity(repository), let url = URL(string: receipt.url),
      url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
      url.port == nil || url.port == 443, url.query == nil, url.fragment == nil,
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
    let path = parts.last == "" ? Array(parts.dropLast()) : parts
    guard path.count >= 3, let number = UInt64(path[path.count - 1]), number > 0,
      path[path.count - 2].lowercased() == (expected.first == "github" ? "pull" : "pullrequest") else { return nil }
    components.path = path.dropLast(2).joined(separator: "/")
    guard let address = components.url?.absoluteString, Self.repositoryIdentity(address) == expected else { return nil }
    return url
  }
  private static func repositoryIdentity(_ raw: String) -> [String]? {
    guard let url = URL(string: raw), let host = url.host?.lowercased(),
      url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
      url.port == nil || url.port == 443, url.query == nil, url.fragment == nil else { return nil }
    var path = url.path
    if path.hasSuffix("/") { path.removeLast() }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.first == "", parts.dropFirst().allSatisfy({ !$0.isEmpty }) else { return nil }
    if host == "github.com", parts.count == 3 {
      let repo = parts[2].hasSuffix(".git") ? String(parts[2].dropLast(4)) : parts[2]
      guard [parts[1], repo].allSatisfy({ $0 != "." && $0 != ".." && $0.range(of: #"^[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil }) else { return nil }
      return ["github", parts[1].lowercased(), repo.lowercased()]
    }
    if host == "dev.azure.com", parts.count == 5, parts[3] == "_git" {
      return ["ado", parts[1].lowercased(), parts[2], parts[4]]
    }
    if host.hasSuffix(".visualstudio.com"), parts.count == 4, parts[2] == "_git" {
      return ["ado", String(host.dropLast(".visualstudio.com".count)), parts[1], parts[3]]
    }
    return nil
  }
}
public struct SavedWorkDraftPreview: Codable, Sendable, Equatable {
  public let podId: String
  public let generation: Int
  public let binding: String
  public let repository: String
  public let baseBranch: String
  public let sources: [SavedWorkSource]
  public let checks: String
  public let blockers: [String]
  public let operation: SavedWorkDraftOperation?
}
