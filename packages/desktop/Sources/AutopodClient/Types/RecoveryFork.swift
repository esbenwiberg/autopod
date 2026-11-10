import Foundation

public struct RecoveryForkFile: Codable, Equatable, Sendable, Identifiable {
  public var id: String { path }
  public var path: String
  public var size: Int64
  public var version: String
}
public struct RecoveryForkSelectedFile: Codable, Equatable, Sendable {
  public let path: String
  public let version: String
  public init(path: String, version: String) { self.path = path; self.version = version }
}
public struct RecoveryForkInput: Codable, Equatable, Sendable {
  public let version: Int
  public let expectedGeneration: Int
  public let sourceHead: String
  public let executionProfileId: String
  public let instructions: String
  public let files: [RecoveryForkSelectedFile]
  public let acknowledgePartialSource: Bool
  public init(expectedGeneration: Int, sourceHead: String, executionProfileId: String,
    instructions: String, files: [RecoveryForkSelectedFile], acknowledgePartialSource: Bool) {
    version = 1; self.expectedGeneration = expectedGeneration; self.sourceHead = sourceHead
    self.executionProfileId = executionProfileId; self.instructions = instructions
    self.files = files; self.acknowledgePartialSource = acknowledgePartialSource
  }
  public var isValid: Bool {
    version == 1 && expectedGeneration >= 1 && RecoveryForkValidation.isSHA(sourceHead)
      && !executionProfileId.isEmpty && executionProfileId.utf16.count <= 128
      && (10...8000).contains(instructions.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
      && acknowledgePartialSource && files.count <= 100 && Set(files.map(\.path)).count == files.count
      && files.allSatisfy { RecoveryFilesSnapshot.safePath($0.path) && RecoveryFilesSnapshot.isHash($0.version) }
      && ((try? JSONEncoder().encode(self).count) ?? Int.max) <= 120_000
  }
}
public struct RecoveryForkRequest: Codable, Equatable, Sendable {
  public let version: Int
  public let id: String
  public let expectedBinding: String
  public let expectedGeneration: Int
  public let sourceHead: String
  public let executionProfileId: String
  public let instructions: String
  public let files: [RecoveryForkSelectedFile]
  public let acknowledgePartialSource: Bool
  public init(id: String = UUID().uuidString.lowercased(), expectedBinding: String, input: RecoveryForkInput) {
    self.id = id; self.expectedBinding = expectedBinding; version = input.version
    expectedGeneration = input.expectedGeneration; sourceHead = input.sourceHead
    executionProfileId = input.executionProfileId; instructions = input.instructions
    files = input.files; acknowledgePartialSource = input.acknowledgePartialSource
  }
  public var input: RecoveryForkInput {
    RecoveryForkInput(expectedGeneration: expectedGeneration, sourceHead: sourceHead,
      executionProfileId: executionProfileId, instructions: instructions, files: files,
      acknowledgePartialSource: acknowledgePartialSource)
  }
  public var isValid: Bool {
    version == 1 && input.isValid && RecoveryFilesSnapshot.isHash(expectedBinding)
      && id.range(of: #"^[a-zA-Z0-9-]{1,64}$"#, options: .regularExpression) != nil
      && ((try? JSONEncoder().encode(self).count) ?? Int.max) <= 131_072
  }
}
/// Only a correlated, explicit server proof of rejection BEFORE the durable claim
/// permits reconsidering a saved request. Generic HTTP errors (including 404) do not.
public struct RecoveryForkRejection: Error, Codable, Equatable, Sendable, LocalizedError {
  public let code: String
  public let parentPodId: String
  public let requestId: String
  public let expectedBinding: String
  public let noOperationCreated: Bool
  public let error: String
  public var errorDescription: String? { error }
  public init(podId: String, request: RecoveryForkRequest, message: String) {
    code = "RECOVERY_FORK_REJECTED_BEFORE_CLAIM"; parentPodId = podId
    requestId = request.id; expectedBinding = request.expectedBinding; noOperationCreated = true; error = message
  }
  public func matches(podId: String, request: RecoveryForkRequest) -> Bool {
    code == "RECOVERY_FORK_REJECTED_BEFORE_CLAIM" && noOperationCreated && parentPodId == podId
      && requestId == request.id && expectedBinding == request.expectedBinding
  }
}
public struct RecoveryForkSource: Codable, Equatable, Sendable {
  public var head: String
  public var tree: String
  public var baseCommitSha: String
  public var branch: String
  public var repository: String
  public var files: [RecoveryForkFile]
  public var truncated: Bool
  public var skippedEntries: Int
  public var caveats: [String]
}
public struct RecoveryForkContext: Codable, Equatable, Sendable {
  public struct Message: Codable, Equatable, Sendable {
    public var role: String
    public var text: String
    public var timestamp: String
    public var eventId: Int
  }
  public var summary: String
  public var failure: String
  public var messages: [Message]
  public var truncated: Bool
  public var omissions: [String]
}
public struct RecoveryForkBudget: Codable, Equatable, Sendable {
  public var taskId: String
  public var status: String
  public var tokenBudget: Int64?
  public var recordedTokens: Int64?
  public var retryAuthorizationRequired: Bool?
  public var allowsAdmission: Bool { ["unlimited", "below_recorded_limit"].contains(status) && retryAuthorizationRequired == false }
}
public struct RecoveryForkExecution: Codable, Equatable, Sendable {
  public var profileId: String
  public var target: String
  public var template: String
  public var platform: String
  public var memoryGb: Double
  public var cpus: Double?
  public var originalTemplate: String
  public var sameEnvironment: Bool
}
public struct RecoveryForkInspection: Codable, Equatable, Sendable {
  public struct Profile: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String
  }
  public struct Lineage: Codable, Equatable, Sendable {
    public var parentPodId: String
    public var operationId: String
  }
  public var version: Int
  public var podId: String
  public var generation: Int
  public var available: Bool
  public var blockers: [String]
  public var source: RecoveryForkSource?
  public var context: RecoveryForkContext
  public var budget: RecoveryForkBudget?
  public var profiles: [Profile]
  public var operation: RecoveryForkOperation?
  public var lineage: Lineage?
  public func validate(podId: String) throws {
    guard version == 1, self.podId == podId, generation >= 0,
      profiles.count <= 1000, Set(profiles.map(\.id)).count == profiles.count,
      !available || (source != nil && budget?.allowsAdmission == true) else { throw URLError(.badServerResponse) }
    try RecoveryForkValidation.validate(source: source, context: context)
    if let operation { try operation.validate(podId: podId) }
  }
}
public struct RecoveryForkPreview: Codable, Equatable, Sendable {
  public var version: Int
  public var podId: String
  public var generation: Int
  public var available: Bool
  public var blockers: [String]
  public var expectedBinding: String?
  public var source: RecoveryForkSource?
  public var context: RecoveryForkContext
  public var budget: RecoveryForkBudget?
  public var execution: RecoveryForkExecution?
  public var input: RecoveryForkInput
  public func validate(podId: String, input: RecoveryForkInput) throws {
    guard version == 1, self.podId == podId, self.input == input, generation >= 0,
      !available || (generation == input.expectedGeneration && source?.head == input.sourceHead
        && execution?.profileId == input.executionProfileId && budget?.allowsAdmission == true
        && RecoveryFilesSnapshot.isHash(expectedBinding ?? "")) else { throw URLError(.badServerResponse) }
    try RecoveryForkValidation.validate(source: source, context: context)
  }
}
public struct RecoveryForkOperation: Codable, Equatable, Sendable {
  public enum State: String, Codable, Sendable { case preparing, queued, qualifying, qualified, failed, unknown }
  public var version: Int
  public var id: String
  public var parentPodId: String
  public var generation: Int
  public var actorId: String
  public var request: RecoveryForkRequest
  public var state: State
  public var childPodId: String?
  public var childStatus: String?
  public var sourceHead: String
  public var copiedFiles: [String]
  public var context: RecoveryForkContext
  public var error: String?
  public var createdAt: String
  public func validate(podId: String, request expected: RecoveryForkRequest? = nil) throws {
    guard version == 1, parentPodId == podId, !actorId.isEmpty, request.isValid,
      id == request.id, generation == request.expectedGeneration, sourceHead == request.sourceHead,
      expected == nil || request == expected,
      childPodId != podId, childPodId == nil || childPodId?.range(of: #"^[a-zA-Z0-9_-]{1,128}$"#, options: .regularExpression) != nil,
      copiedFiles.count <= 100,
      Set(copiedFiles).count == copiedFiles.count,
      copiedFiles.allSatisfy({ request.files.map(\.path).contains($0) }),
      ![.queued, .qualifying, .qualified].contains(state) || (childPodId?.isEmpty == false && Set(copiedFiles) == Set(request.files.map(\.path))) else { throw URLError(.badServerResponse) }
    try RecoveryForkValidation.validate(source: nil, context: context)
  }
}
private enum RecoveryForkValidation {
  static func isSHA(_ value: String) -> Bool {
    [40, 64].contains(value.count) && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  static func validate(source: RecoveryForkSource?, context: RecoveryForkContext) throws {
    guard context.messages.count <= 100, Set(context.messages.map(\.eventId)).count == context.messages.count,
      context.messages.allSatisfy({ ["human", "assistant"].contains($0.role) }),
      ((try? JSONEncoder().encode(context).count) ?? Int.max) <= 131_072 else { throw URLError(.badServerResponse) }
    if let source {
      guard isSHA(source.head), isSHA(source.tree), isSHA(source.baseCommitSha), source.files.count <= 2000,
        source.skippedEntries >= 0, Set(source.files.map(\.path)).count == source.files.count,
        source.files.allSatisfy({ RecoveryFilesSnapshot.safePath($0.path) && RecoveryFilesSnapshot.isHash($0.version)
          && (0...5 * 1024 * 1024).contains($0.size) }) else { throw URLError(.badServerResponse) }
    }
  }
}
