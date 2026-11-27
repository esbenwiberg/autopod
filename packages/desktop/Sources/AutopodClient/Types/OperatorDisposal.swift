import Foundation

public struct OperatorDisposalReceipt: Codable, Sendable {
  public let contract: String
  public let podId: String
  public let generation: Int
  public let requestKey: String
  public let intent: String
  public let acceptedAt: String
  public let state: String
  public let diagnostics: [String]
  public let resources: [OperatorDisposalResource]?
}

public struct OperatorDisposalResource: Codable, Sendable {
  public let kind: String
  public let id: String
  public let namespace: String
  public let stopDispatched: Bool
  public let discardDispatched: Bool
  public let observedStopped: Bool
  public let observedAbsent: Bool
}
