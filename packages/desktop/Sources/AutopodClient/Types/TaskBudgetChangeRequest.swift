import Foundation

/// Both keys are required by the daemon, including explicit null for an unlimited budget.
public struct TaskBudgetChangeRequest: Encodable, Equatable, Sendable {
  public let tokenBudget: Int?
  public let expectedBudget: Int?

  public init(tokenBudget: Int?, expectedBudget: Int?) {
    self.tokenBudget = tokenBudget
    self.expectedBudget = expectedBudget
  }

  private enum CodingKeys: String, CodingKey { case tokenBudget, expectedBudget }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(tokenBudget, forKey: .tokenBudget)
    try container.encode(expectedBudget, forKey: .expectedBudget)
  }
}
