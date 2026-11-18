import Foundation

/// Projection of the existing retained-checkpoint protocol; no new job or coding intent.
public struct MemoryChecksInspection: Decodable, Sendable {
  public let inspection: Assessment?
  public let operations: [MemoryChecksOperation]
  public struct Assessment: Decodable, Sendable {
    public let generation: Int
    public let selection: Selection?
    public let memoryRecovery: Memory?
  }
  public struct Selection: Decodable, Sendable {
    public let expectedGeneration: Int
    public let expectedResultHash: String
  }
  public struct Memory: Decodable, Sendable {
    public let version: Int
    public let state: String
    public let reason: String
    public let source: Source?
    public let priorMemory: Measurement?
    public let predecessorId: String?
    public let candidateQualification: String
  }
  public struct Source: Decodable, Sendable {
    public let head: String
    public let tree: String
  }
  public struct Measurement: Decodable, Sendable {
    public let heapLimitBytes: Int
    public let containerLimitBytes: Int
  }
}

public struct MemoryChecksPreview: Decodable, Sendable {
  public let profileId: String
  public let digest: String
  public let target: String
}

public struct MemoryChecksRequest: Codable, Equatable, Sendable {
  public let id: String
  public let expectedGeneration: Int
  public let expectedResultHash: String
  public let checkpointHead: String
  public let mode: String
  public let qualification: String
  public let reason: String
  public let executionProfileId: String
  public let expectedExecutionDigest: String

  public init(id: String, generation: Int, resultHash: String, head: String, profile: String, digest: String, reason: String) {
    self.id = id; expectedGeneration = generation; expectedResultHash = resultHash; checkpointHead = head
    mode = "checks"; qualification = "Require measured effective Node test heap improvement on unchanged saved checks before dispatch."
    self.reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    executionProfileId = profile; expectedExecutionDigest = digest
  }
  public func validate() throws {
    guard id.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil,
      expectedGeneration > 0, mode == "checks", qualification.count >= 20,
      expectedResultHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      checkpointHead.range(of: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", options: .regularExpression) != nil,
      expectedExecutionDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      executionProfileId.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil,
      (10...4000).contains(reason.count) else { throw DaemonError.badRequest("Invalid saved checks-only selection") }
  }
}

public struct MemoryChecksOperation: Decodable, Sendable {
  public let id: String
  public let podId: String
  public let generation: Int
  public let reason: String
  public let binding: Binding
  public let activated: Generation?
  public let checking: Generation?
  public let checked: Checked?
  public let blocked: Blocked?
  public struct Generation: Decodable, Sendable { public let generation: Int }
  public struct Checked: Decodable, Sendable { public let result: Result }
  public struct Result: Decodable, Sendable { public let overall: String }
  public struct Blocked: Decodable, Sendable { public let code: String }
  public struct Binding: Decodable, Sendable {
    public let head: String
    public let resultHash: String
    public let continuation: Continuation?
  }
  public struct Continuation: Decodable, Sendable {
    public let execution: Execution?
    public let infrastructure: Infrastructure?
  }
  public struct Execution: Decodable, Sendable { public let profileId: String; public let digest: String }
  public struct Infrastructure: Decodable, Sendable {
    public let mode: String
    public let qualification: String
    public let predecessorChecksId: String?
  }
  public func validate(podId: String, request: MemoryChecksRequest) throws {
    try request.validate()
    guard self.podId == podId, id == request.id, generation == request.expectedGeneration,
      binding.head == request.checkpointHead, binding.resultHash == request.expectedResultHash,
      reason == request.reason, binding.continuation?.infrastructure?.mode == "checks",
      binding.continuation?.infrastructure?.qualification == request.qualification,
      binding.continuation?.infrastructure?.predecessorChecksId != nil,
      binding.continuation?.execution?.profileId == request.executionProfileId,
      binding.continuation?.execution?.digest == request.expectedExecutionDigest else {
      throw DaemonError.decodingError("Uncorrelated checks receipt; observe the saved request")
    }
  }
}
