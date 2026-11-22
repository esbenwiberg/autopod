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

/// Response to POST /pods/:id/continue-budget (mirrors `BudgetContinuationResponse`).
public struct BudgetContinuationResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let action: String
  public let budgetExtensionsUsed: Int
  public let maxBudgetExtensions: Int?
  /// `started`: approval is recorded and validation runs in the background.
  public let validation: String

  public init(
    ok: Bool = true, action: String = "continue-budget", budgetExtensionsUsed: Int,
    maxBudgetExtensions: Int?, validation: String = "started"
  ) {
    self.ok = ok
    self.action = action
    self.budgetExtensionsUsed = budgetExtensionsUsed
    self.maxBudgetExtensions = maxBudgetExtensions
    self.validation = validation
  }
}
