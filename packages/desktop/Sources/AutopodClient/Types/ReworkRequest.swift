import Foundation

public struct ReworkEligibility: Codable, Sendable {
  public let eligible: Bool
  public let status: String
  public let reason: String
  public let generation: Int
  public let failureId: String?
  public let notBefore: String?
}
public struct ReworkRequest: Codable, Sendable {
  public let requestKey: String
  public let generation: Int
  public let guidance: String
  public init(requestKey: String, generation: Int, guidance: String) {
    self.requestKey = requestKey; self.generation = generation; self.guidance = guidance
  }
}
public struct ReworkRequestReceipt: Codable, Sendable {
  public let requestKey: String
  public let generation: Int
  public let guidance: String
  public let settledAt: String?
  public let error: String?
}
