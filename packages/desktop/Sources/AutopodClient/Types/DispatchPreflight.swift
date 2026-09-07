import Foundation

public struct IntentionalRerunRequest: Codable, Sendable {
  public let ofPodId: String
  public let reason: String
  public let requestKey: String
  public init(ofPodId: String, reason: String, requestKey: String) {
    self.ofPodId = ofPodId; self.reason = reason; self.requestKey = requestKey
  }
}
public struct DispatchPreflightResponse: Codable, Sendable {
  public let latest: DispatchPreflightEvidence?
}
public struct DispatchPreflightEvidence: Codable, Sendable {
  public let id: String
  public let executionId: String
  public let taskId: String
  public let repository: String
  public let baseBranch: String
  public let baseCommitSha: String
  public let status: String
  public let checkedAt: String
  public let conflicts: [DispatchConflict]
  public let rerun: IntentionalRerunRequest?
}
public struct DispatchConflict: Codable, Sendable, Identifiable {
  public var id: String { executionId }
  public let podId: String
  public let executionId: String
  public let status: String
  public let evidence: String
}
