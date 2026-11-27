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
}
