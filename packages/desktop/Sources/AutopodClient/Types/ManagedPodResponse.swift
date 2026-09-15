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
  public var validationStatus: String? = nil
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

public struct ManagedValidationReceipt: Codable, Sendable, Identifiable {
  public var id: String { validationId }
  public let validationId: String
  public let mode: String
  public let status: String
  public let newCommit: String
  public let reason: String
  public let receiptDigest: String
  public let phases: [ManagedValidationPhase]
}
public struct ManagedValidationPhase: Codable, Sendable, Identifiable {
  public var id: String { phase }
  public let phase: String
  public let status: String
  public let durationMs: Int
}
public struct ManagedCandidate: Codable, Sendable, Identifiable {
  public var id: String { candidateId }
  public let candidateId: String
  public let newCommit: String
}
public struct ManagedSourceReceipt: Codable, Sendable, Identifiable {
  public var id: String { operationKey }
  public let operationKey: String
  public let operation: String
  public let head: String
  public let status: String
  public let pullRequestId: Int
}
public struct ManagedVerification: Codable, Sendable {
  public let status: String
}
public struct ManagedTimelineEvent: Codable, Sendable, Identifiable {
  public var id: String { eventId }
  public let eventId: String
  public let kind: String
  public let createdAt: Int
}
public struct ManagedPodDetailResponse: Codable, Sendable {
  public let pod: ManagedPodSummary
  public let validations: [ManagedValidationReceipt]
  public let candidates: [ManagedCandidate]
  public let source: [ManagedSourceReceipt]
  public let verification: ManagedVerification?
  public let events: [ManagedTimelineEvent]
}
public struct ManagedArtifactManifest: Codable, Sendable {
  public let files: [ManagedArtifactFile]
  public let bundle: ManagedArtifactBundle
}
public struct ManagedArtifactFile: Codable, Sendable, Identifiable {
  public var id: String { path }
  public let path: String
  public let size: Int
  public let sha256: String
  public let mediaType: String
}
public struct ManagedArtifactBundle: Codable, Sendable {
  public let format: String
  public let size: Int
  public let sha256: String
}
