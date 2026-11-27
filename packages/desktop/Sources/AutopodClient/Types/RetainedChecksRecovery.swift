import Foundation

/// A read-only observation of the exact clean host Git checkpoint, not retry permission.
public struct RetainedChecksPreview: Codable, Equatable, Sendable {
  public let version: Int
  public let podId: String
  public let branch: String
  public let checkpointHead: String
  public let checkpointTree: String
  public let expectedGeneration: Int
  public let expectedResultHash: String

  public func validate(podId: String) throws {
    guard version == 1, self.podId == podId, !branch.isEmpty, expectedGeneration > 0,
      expectedResultHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      [checkpointHead, checkpointTree].allSatisfy({
        $0.range(of: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", options: .regularExpression) != nil
      }) else { throw DaemonError.decodingError("Uncorrelated saved-source inspection") }
  }
}

/// The persisted desktop selection. Only the fields understood by the existing
/// retained-continuation protocol are transmitted.
public struct RetainedChecksDecision: Codable, Equatable, Sendable {
  public let id: String
  public let preview: RetainedChecksPreview
  public let reason: String

  public init(id: String, preview: RetainedChecksPreview, reason: String) {
    self.id = id
    self.preview = preview
    self.reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public func validate(podId: String) throws {
    try preview.validate(podId: podId)
    guard id.range(of: "^[a-zA-Z0-9-]{1,64}$", options: .regularExpression) != nil,
      (10...4000).contains(reason.utf16.count),
      reason == reason.trimmingCharacters(in: .whitespacesAndNewlines)
    else { throw DaemonError.badRequest("A saved request ID and a reason of 10–4000 characters are required") }
  }
}

public struct RetainedChecksOperation: Decodable, Sendable {
  public let id: String
  public let podId: String
  public let generation: Int
  public let reason: String
  public let binding: Binding
  public let activated: Generation?
  public let checking: Generation?
  public let checked: MemoryChecksOperation.Checked?
  public let blocked: MemoryChecksOperation.Blocked?
  public struct Generation: Decodable, Sendable { public let generation: Int }
  public struct Binding: Decodable, Sendable {
    public let branch: String
    public let head: String
    public let resultHash: String
    public let continuation: Continuation?
  }
  public struct Continuation: Decodable, Sendable {
    public let prepareOnly: Bool
    public let reviewPolicy: String?
    public let remoteHead: String?
    public let execution: MemoryChecksOperation.Execution?
    public let infrastructure: MemoryChecksOperation.Infrastructure?
  }

  public func validate(podId: String, decision: RetainedChecksDecision) throws {
    try decision.validate(podId: podId)
    let preview = decision.preview
    guard self.podId == podId, id == decision.id, generation == preview.expectedGeneration,
      reason == decision.reason, binding.branch == preview.branch,
      binding.head == preview.checkpointHead, binding.resultHash == preview.expectedResultHash,
      let continuation = binding.continuation, !continuation.prepareOnly,
      continuation.reviewPolicy == "independent-v1", continuation.remoteHead == nil,
      continuation.execution == nil, continuation.infrastructure == nil,
      checking == nil || checking?.generation == activated?.generation,
      checked == nil || checking != nil
    else { throw DaemonError.decodingError("Uncorrelated fresh checks receipt; observe the saved request") }
    if let activated, activated.generation <= generation || activated.generation - generation != 1 {
      throw DaemonError.decodingError("Unexpected fresh checks generation")
    }
    if let checked, checked.result.overall == "pass" {
      guard checked.source?.head == preview.checkpointHead,
        checked.source?.tree == preview.checkpointTree, blocked == nil
      else { throw DaemonError.decodingError("Passing checks are not bound to the selected source") }
    }
  }
}
