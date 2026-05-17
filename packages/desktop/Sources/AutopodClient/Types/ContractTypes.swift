import Foundation

public struct SpecContractResponse: Codable, Sendable, Hashable {
  public let contractVersion: Int
  public let title: String
  public let dependsOn: [String]
  public let scenarios: [ContractScenarioResponse]
  public let requiredFacts: [RequiredFactResponse]
  public let humanReview: [HumanReviewItemResponse]
}

public struct ContractScenarioResponse: Codable, Sendable, Hashable {
  public let id: String
  public let given: [String]
  public let when: [String]
  public let then: [String]
}

public struct RequiredFactResponse: Codable, Sendable, Hashable {
  public let id: String
  public let proves: [String]
  public let kind: String
  public let artifact: FactArtifactResponse
  public let command: String
}

public struct FactArtifactResponse: Codable, Sendable, Hashable {
  public let path: String
  public let change: String
}

public struct HumanReviewItemResponse: Codable, Sendable, Hashable {
  public let id: String
  public let covers: [String]
  public let criterion: String
  public let reason: String
}

public struct FactEvidenceResponse: Codable, Sendable, Hashable {
  public let factId: String
  public let artifactPath: String
  public let command: String
  public let result: String
  public let notes: String?
}
