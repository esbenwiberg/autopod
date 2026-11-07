import Foundation

public struct StalledWorkerRecoveryRequest: Codable, Sendable, Equatable {
  public let requestKey: String
  public let expectedGeneration: Int
  public let expectedBinding: String
  public let reason: String

  public init(requestKey: String, expectedGeneration: Int, expectedBinding: String, reason: String) {
    self.requestKey = requestKey; self.expectedGeneration = expectedGeneration
    self.expectedBinding = expectedBinding; self.reason = reason
  }
}

public struct StalledWorkerRecoveryReceipt: Codable, Sendable {
  public enum State: String, Codable, Sendable { case pending, settled }
  public let podId: String
  public let request: StalledWorkerRecoveryRequest
  public let actor: RetainedFinalizationReceipt.Actor
  public let state: State
  public let createdAt: String
  public let settledAt: String?
  public let message: String
  public let resourcesRetained: Bool
}

public struct StalledWorkerRecoveryView: Codable, Sendable {
  public let schemaVersion: Int
  public let podId: String
  public let generation: Int
  public let status: String
  public let binding: String
  public let canStop: Bool
  public let blockers: [String]
  public let failureReason: String?
  public let guidanceBlocker: String?
  public let operation: StalledWorkerRecoveryReceipt?
}
