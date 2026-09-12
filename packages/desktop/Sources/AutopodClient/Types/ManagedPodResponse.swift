import Foundation

public struct ManagedPodPageResponse: Codable, Sendable {
  public let schemaVersion: Int
  public let pods: [ManagedPodSummary]
  public let nextCursor: String?
}

public struct ManagedPodFailure: Codable, Hashable, Sendable {
  public let phase: String
  public let reason: String
  public let httpStatus: Int?
}

public struct ManagedArtifactSummary: Codable, Hashable, Identifiable, Sendable {
  public var id: String { artifactId }
  public let artifactId: String
  public let status: String
  public let fileCount: Int
  public let totalBytes: Int
  public let committedAt: Int?
}

public struct ManagedPodSummary: Codable, Hashable, Identifiable, Sendable {
  public var id: String { podId }
  public let podId: String
  public let dispatcherAttemptId: String
  public let state: String
  public let providerAccountId: String
  public let model: String
  public let runtime: String
  public let executionTarget: String
  public let reasoning: String
  public let profileId: String
  public let profileVersion: Int
  public let providerRequests: Int
  public let consumedTokens: Int
  public let tokenUsageKnown: Bool
  public let failure: ManagedPodFailure?
  public let limitations: [String]
  public let artifacts: [ManagedArtifactSummary]
  public let revoked: Bool
  public let stopRequested: Bool
  public let observedExit: Bool
  public let cleanup: String
  public let exitCode: Int?
  public let createdAt: Int
  public let lastEventAt: Int

  public var createdDate: Date { Date(timeIntervalSince1970: TimeInterval(createdAt)) }
  public var lastEventDate: Date { Date(timeIntervalSince1970: TimeInterval(lastEventAt)) }
}
