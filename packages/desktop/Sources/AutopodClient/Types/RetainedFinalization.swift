import Foundation

public enum RetainedFinalizationMode: String, Codable, Sendable {
  case stopRetain = "stop-retain"
  case completeMerged = "complete-merged"
}

public struct RetainedFinalizationRequest: Codable, Sendable, Equatable {
  public let requestKey: String
  public let expectedGeneration: Int
  public let expectedBinding: String
  public let mode: RetainedFinalizationMode
  public let reason: String

  public init(requestKey: String, expectedGeneration: Int, expectedBinding: String,
              mode: RetainedFinalizationMode, reason: String) {
    self.requestKey = requestKey; self.expectedGeneration = expectedGeneration
    self.expectedBinding = expectedBinding; self.mode = mode; self.reason = reason
  }
}

public struct RetainedFinalizationReceipt: Codable, Sendable {
  public enum State: String, Codable, Sendable { case pending, finalized }
  public struct Actor: Codable, Sendable {
    public let type: String
    public let userId: String?
    public let displayName: String?
  }
  public let podId: String
  public let request: RetainedFinalizationRequest
  public let actor: Actor
  public let state: State
  public let createdAt: String
  public let finalizedAt: String?
  public let message: String
  public let resourcesRetained: Bool
}

public struct RetainedFinalizationView: Codable, Sendable {
  public struct Custody: Codable, Sendable {
    public let kind: String
    public let id: String
  }
  public let podId: String
  public let generation: Int
  public let status: String
  public let binding: String
  public let custody: [Custody]
  public let canStop: Bool
  public let canCompleteMerged: Bool
  public let blockers: [String]
  public let operation: RetainedFinalizationReceipt?
}
