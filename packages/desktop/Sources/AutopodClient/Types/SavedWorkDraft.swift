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
      let url = URL(string: receipt.url), let repo = URL(string: repository),
      url.scheme == "https", url.host == repo.host, url.user == nil, url.password == nil,
      url.path.hasPrefix(repo.path.replacingOccurrences(of: #"\.git$"#, with: "", options: .regularExpression) + "/") else { return nil }
    return url
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
