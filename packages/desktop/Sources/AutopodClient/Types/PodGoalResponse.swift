import Foundation

public struct PodGoalResponse: Codable, Equatable, Sendable {
  public let podId: String
  public let objective: String
  public let state: String
  public let revision: Int
  public let runtime: String
  public let nativeSessionId: String?
  public let nativeStatus: String?
  public let executionStopped: Bool
  public let controlIntent: String?
  public let observedTokens: Int
  public let observedSeconds: Double
  public let reason: String?
  public let createdAt: String
  public let updatedAt: String
}

public struct PodGoalControlRequest: Codable, Sendable {
  public let revision: Int
  public let intent: String
  public init(revision: Int, intent: String) {
    self.revision = revision
    self.intent = intent
  }
}
