import Foundation

public struct SandboxRecoveryState: Decodable, Sendable {
  public let podId: String
  public let generation: Int
  public let currentUserId: String?
  public let resources: [SandboxRecoveryResource]
  public let operations: [SandboxRecoveryReceipt]
  public let wakeups: [SandboxWakeupEvidence]
}

public struct SandboxRecoveryResource: Decodable, Sendable, Identifiable {
  public var id: String { resourceKey }
  public let sandboxId: String
  public let resourceKey: String
  public let providerState: String
  public let observedAt: String
  public let observationError: String?
  public let pendingIntentIds: [String]
  public let startBlocked: String?
  public let abandonBlocked: String?
  public let abandonment: SandboxRecoveryReceipt?
}

public struct SandboxRecoveryReceipt: Codable, Sendable, Identifiable {
  public let id: String
  public let podId: String
  public let sandboxId: String
  public let resourceKey: String
  public let generation: Int
  public let action: String
  public let userId: String
  public let reason: String
  public let createdAt: String
  public let completedAt: String?
}

public struct SandboxWakeupEvidence: Decodable, Sendable, Identifiable {
  public let id: String
  public let sandboxId: String
  public let startedAt: String
  public let dispatchStartedAt: String?
  public let endedAt: String?
  public let settledBy: String?
  public let evidence: [Entry]
  public struct Entry: Decodable, Sendable {
    public let recordedAt: String
    public let kind: String
    public let status: Int?
    public let errorCode: String?
    public let diagnostics: [String: String]
  }
}

public struct SandboxRecoveryRequest: Codable, Sendable, Equatable {
  public let id: String
  public let action: String
  public let sandboxId: String
  public let expectedGeneration: Int
  public let expectedResourceKey: String
  public let reason: String
  public let acknowledgeDataLoss: Bool

  public init(id: String = UUID().uuidString, action: String, sandboxId: String,
              expectedGeneration: Int, expectedResourceKey: String, reason: String,
              acknowledgeDataLoss: Bool = false) {
    self.id = id; self.action = action; self.sandboxId = sandboxId
    self.expectedGeneration = expectedGeneration; self.expectedResourceKey = expectedResourceKey
    self.reason = reason; self.acknowledgeDataLoss = acknowledgeDataLoss
  }

  /// A pending abandonment is resumed by exact ID, never by inventing another decision.
  public init(abandonment: SandboxRecoveryReceipt) {
    self.init(id: abandonment.id, action: abandonment.action, sandboxId: abandonment.sandboxId,
              expectedGeneration: abandonment.generation, expectedResourceKey: abandonment.resourceKey,
              reason: abandonment.reason, acknowledgeDataLoss: true)
  }
}

public struct SandboxRecoveryResult: Decodable, Sendable {
  public let operation: SandboxRecoveryReceipt
  public let podDeleted: Bool
  public let cleanupError: String?
}
