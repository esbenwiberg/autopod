import CryptoKit
import Foundation

// Wire mirrors of @autopod/shared repair-continuation.schema.ts (including required retained operationId).
// Preview is STATIC conditional eligibility; only daemon qualification/admission starts coding.
public struct RepairContinuationRequestV1: Codable, Equatable, Sendable {
  public let version: Int
  public let intent: String
  public let id: String
  public let expectedGeneration: Int
  public let expectedResultHash: String
  public let expectedReportSetHash: String
  public let sourceHead: String
  public let executionProfileId: String
  public let expectedExecutionDigest: String
  public let expectedBindingDigest: String
  public let reason: String

  public init(id: String, selection: RepairContinuationSelectionV1, reason: String) {
    version = 1; intent = "qualify_then_code_once"; self.id = id
    expectedGeneration = selection.expectedGeneration; expectedResultHash = selection.expectedResultHash
    expectedReportSetHash = selection.expectedReportSetHash; sourceHead = selection.sourceHead
    executionProfileId = selection.executionProfileId; expectedExecutionDigest = selection.expectedExecutionDigest
    expectedBindingDigest = selection.expectedBindingDigest; self.reason = reason
  }

  public func validate() throws {
    try RepairWire.require(version == 1 && intent == "qualify_then_code_once" && RepairWire.id(id)
      && RepairWire.generation(expectedGeneration) && RepairWire.sha(sourceHead) && RepairWire.id(executionProfileId)
      && [expectedResultHash, expectedReportSetHash, expectedExecutionDigest, expectedBindingDigest].allSatisfy(RepairWire.hash)
      && (10...4000).contains(reason.utf16.count) && reason == reason.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}

public struct RepairContinuationSelectionV1: Codable, Equatable, Sendable {
  public let expectedGeneration: Int
  public let expectedResultHash: String
  public let expectedReportSetHash: String
  public let sourceHead: String
  public let executionProfileId: String
  public let expectedExecutionDigest: String
  public let expectedBindingDigest: String
  public let requirementsHash: String
  public let target: String

  fileprivate func validate() throws {
    try RepairContinuationRequestV1(id: "validation", selection: self, reason: "Validate static selection").validate()
    try RepairWire.require(RepairWire.hash(requirementsHash) && target == "local")
  }
}

public struct RepairContinuationRefusal: Codable, Equatable, Sendable {
  public let code: String
  public let message: String
  fileprivate func validate() throws {
    try RepairWire.require(Self.codes.contains(code) && !message.isEmpty && message.utf16.count <= 1024)
  }
  private static let codes: Set<String> = ["unavailable", "unsupported_task", "unsupported_needs", "incomplete_reports", "stale_selection", "conflict", "custody_held", "execution_unsettled", "pending_decision", "uncollected_guidance", "source_unavailable", "configuration_changed", "retry_blocked", "budget_blocked", "qualification_failed", "qualification_unknown", "qualification_expired", "source_seal_failed", "checks_failed", "internal_error"]
}

public struct RepairExecutionDisplayV1: Codable, Equatable, Sendable {
  public let target: String
  public let template: String
  public let imageKey: String
  public let platform: String
  public let memoryGb: Double
  public let cpus: Double?
  fileprivate func validate() throws {
    try RepairWire.require(["local", "sandbox"].contains(target) && !template.isEmpty && template.utf16.count <= 128
      && RepairWire.hash(imageKey) && ["linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64"].contains(platform)
      && memoryGb.isFinite && memoryGb > 0 && memoryGb <= 1024
      && (cpus == nil || (cpus!.isFinite && cpus! > 0 && cpus! <= 1024)))
  }
}
public struct RepairConfigurationDiffV1: Codable, Equatable, Sendable {
  public let before: RepairExecutionDisplayV1
  public let after: RepairExecutionDisplayV1
}
public struct RepairContinuationPreviewV1: Codable, Equatable, Sendable {
  public let version: Int
  public let intent: String
  public let podId: String
  public let configurationOnly: Bool
  public let actualQualification: String
  public let conditionalAttemptEligible: Bool
  public let selection: RepairContinuationSelectionV1?
  public let configurationDiff: RepairConfigurationDiffV1?
  public let refusals: [RepairContinuationRefusal]

  public func validate(podId: String, sourceHead: String, profileId: String) throws {
    try RepairWire.require(version == 1 && intent == "qualify_then_code_once" && self.podId == podId
      && configurationOnly && actualQualification == "not_run")
    try RepairWire.refusals(refusals)
    if let selection {
      try selection.validate()
      try RepairWire.require(selection.sourceHead == sourceHead && selection.executionProfileId == profileId)
    }
    if let configurationDiff { try configurationDiff.before.validate(); try configurationDiff.after.validate() }
    try RepairWire.require(!conditionalAttemptEligible || (selection != nil && configurationDiff?.after.target == "local" && configurationDiff?.after.platform.hasPrefix("linux/") == true && refusals.isEmpty))
  }
}
public struct RepairContinuationInspectionV1: Codable, Equatable, Sendable {
  public let version: Int
  public let intent: String
  public let podId: String
  public let generation: Int
  public let available: Bool
  public let expectedResultHash: String?
  public let expectedReportSetHash: String?
  public let sourceHead: String?
  public let requirementsHash: String?
  public let operation: RepairContinuationOperationV1?
  public let refusals: [RepairContinuationRefusal]

  public func validate(podId: String) throws {
    try RepairWire.require(version == 1 && intent == "qualify_then_code_once" && self.podId == podId && RepairWire.generation(generation)
      && [expectedResultHash, expectedReportSetHash, requirementsHash].compactMap { $0 }.allSatisfy(RepairWire.hash)
      && (sourceHead == nil || RepairWire.sha(sourceHead!)))
    try RepairWire.refusals(refusals)
    if let operation { try operation.validate(podId: podId, requestId: operation.request.id) }
  }
}
public enum RepairContinuationStateV1: String, Codable, Sendable {
  case claimed, preparing, provisioning, qualifying, qualified, coding, sealing, checking, validated, failed, unknown
}
public enum RepairCodingAdmission: String, Codable, Sendable { case notAdmitted = "not_admitted", consumed, unknown }
public enum RepairChecks: String, Codable, Sendable { case notStarted = "not_started", running, passed, failed, unknown }
public enum RepairQualificationOutcome: String, Codable, Sendable { case qualified, failed, unknown, unsupported }

public struct RepairSourceIdentityV1: Codable, Equatable, Sendable {
  public let repository: String
  public let head: String
  public let tree: String
  public let baseCommitSha: String
  fileprivate func validate() throws {
    try RepairWire.require(!repository.isEmpty && repository.utf16.count <= 2048 && [head, tree, baseCommitSha].allSatisfy(RepairWire.sha))
  }
}
public struct RepairImageIdentityV1: Codable, Equatable, Sendable {
  public let kind: String
  public let digest: String
}
public struct EnvironmentQualificationBindingV1: Codable, Equatable, Sendable {
  public let version: Int
  public let operationId: String
  public let requestHash: String
  public let podId: String
  public let taskId: String
  public let executionId: String
  public let custodyId: String
  public let originalGeneration: Int
  public let candidateGeneration: Int
  public let originalResultHash: String
  public let reportSetHash: String
  public let requirementsHash: String
  public let originalLaunchDigest: String
  public let replacementLaunchDigest: String
  public let configurationHash: String
  public let sourceEpoch: String
  public let credentialEpoch: String
  public let resourceEpoch: String
  public let source: RepairSourceIdentityV1
  public let target: String
  public let containerId: String
  public let resourceKey: String
  public let expectedImage: RepairImageIdentityV1
  public let platform: String
  public let executionContextHash: String
  fileprivate func validate() throws {
    try RepairWire.require(version == 1 && [operationId, podId, taskId, executionId, custodyId].allSatisfy(RepairWire.id)
      && RepairWire.generation(originalGeneration) && RepairWire.generation(candidateGeneration)
      && [requestHash, originalResultHash, reportSetHash, requirementsHash, originalLaunchDigest, replacementLaunchDigest,
        configurationHash, sourceEpoch, credentialEpoch, resourceEpoch, executionContextHash, containerId].allSatisfy(RepairWire.hash)
      && target == "local" && !resourceKey.isEmpty && resourceKey.utf16.count <= 2048
      && expectedImage.kind == "docker-image-id" && RepairWire.matches(expectedImage.digest, "^sha256:[a-f0-9]{64}$")
      && ["linux/amd64", "linux/arm64"].contains(platform))
    try source.validate()
  }
}
public struct EnvironmentQualificationObservationV1: Codable, Equatable, Sendable {
  public let prerequisite: String
  public let launcher: String?
  public let outcome: RepairQualificationOutcome
  public let code: String
  public let detail: String
}
public struct EnvironmentQualificationEvidenceV1: Codable, Equatable, Sendable {
  public let version: Int
  public let binding: EnvironmentQualificationBindingV1
  public let bindingDigest: String
  public let probeVersion: Int
  public let daemonCommit: String?
  public let implementationHash: String?
  public let startedAt: String
  public let finishedAt: String
  public let expiresAt: String
  public let outcome: RepairQualificationOutcome
  public let observations: [EnvironmentQualificationObservationV1]
  public let provenanceId: String?
  // Captured from the full wire value, NOT JSONEncoder(binding) (which can drop fields).
  private let decodedBindingDigest: String

  private enum CodingKeys: String, CodingKey {
    case version, binding, bindingDigest, probeVersion, daemonCommit, implementationHash
    case startedAt, finishedAt, expiresAt, outcome, observations, provenanceId
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try c.decode(RepairBindingCanonicalJSON.self, forKey: .binding)
    try raw.validateBindingShape()
    decodedBindingDigest = raw.digest
    version = try c.decode(Int.self, forKey: .version)
    binding = try c.decode(EnvironmentQualificationBindingV1.self, forKey: .binding)
    bindingDigest = try c.decode(String.self, forKey: .bindingDigest)
    probeVersion = try c.decode(Int.self, forKey: .probeVersion)
    daemonCommit = try c.decodeIfPresent(String.self, forKey: .daemonCommit)
    implementationHash = try c.decodeIfPresent(String.self, forKey: .implementationHash)
    startedAt = try c.decode(String.self, forKey: .startedAt)
    finishedAt = try c.decode(String.self, forKey: .finishedAt)
    expiresAt = try c.decode(String.self, forKey: .expiresAt)
    outcome = try c.decode(RepairQualificationOutcome.self, forKey: .outcome)
    observations = try c.decode([EnvironmentQualificationObservationV1].self, forKey: .observations)
    provenanceId = try c.decodeIfPresent(String.self, forKey: .provenanceId)
  }
  fileprivate func validate() throws {
    try binding.validate()
    try RepairWire.require(bindingDigest == decodedBindingDigest)
    guard let start = RepairWire.date(startedAt), let end = RepairWire.date(finishedAt), let expiry = RepairWire.date(expiresAt) else { throw RepairWire.error }
    try RepairWire.require(version == 1 && probeVersion == 1 && RepairWire.hash(bindingDigest)
      && (daemonCommit?.utf16.count ?? 0) <= 128 && (implementationHash == nil || RepairWire.hash(implementationHash!))
      && (provenanceId == nil || RepairWire.id(provenanceId!)) && end >= start && expiry >= end && expiry.timeIntervalSince(end) <= 300
      && (1...96).contains(observations.count) && (outcome != .qualified || observations.allSatisfy { $0.outcome == .qualified }))
    for item in observations {
      try RepairWire.require(["resource_identity", "image", "platform", "source", "memory", "cpu", "streaming", "agent_cli", "launcher", "preparation"].contains(item.prerequisite)
        && (item.launcher == nil || (item.launcher!.utf16.count <= 256 && RepairWire.matches(item.launcher!, "^[A-Za-z0-9_][A-Za-z0-9_.+-]*$")))
        && item.code.utf16.count <= 80 && RepairWire.matches(item.code, "^[A-Z][A-Z0-9_]*$") && !item.detail.isEmpty && item.detail.utf16.count <= 1024)
    }
  }
}
public struct RepairCodingFinalSourceV1: Codable, Equatable, Sendable {
  public let version: Int
  public let operationId: String
  public let generation: Int
  public let taskRunId: String
  public let selectedHead: String
  public let source: RepairSourceIdentityV1
  public let clean: Bool
  public let descendant: Bool
  public let workerSettled: Bool
  public let sealedAt: String
  public let reportsHash: String
  fileprivate func validate() throws {
    try source.validate()
    try RepairWire.require(version == 1 && RepairWire.id(operationId) && RepairWire.id(taskRunId) && RepairWire.generation(generation)
      && RepairWire.sha(selectedHead) && clean && descendant && workerSettled && RepairWire.date(sealedAt) != nil && RepairWire.hash(reportsHash))
  }
}
public struct RepairContinuationOperationV1: Codable, Equatable, Sendable {
  /// Internal retained operation/custody identity, not the external request replay key.
  public let operationId: String
  public let version: Int
  public let intent: String
  public let podId: String
  public let request: RepairContinuationRequestV1
  public let state: RepairContinuationStateV1
  public let createdAt: String
  public let updatedAt: String
  public let originalGeneration: Int
  public let candidateGeneration: Int?
  public let qualification: EnvironmentQualificationEvidenceV1?
  public let codingFinalSource: RepairCodingFinalSourceV1?
  public let codingAdmission: RepairCodingAdmission
  public let checks: RepairChecks
  public let refusals: [RepairContinuationRefusal]
  public let originalResourcesRetained: Bool
  public let requiresHumanApproval: Bool
  public let publicationAuthorized: Bool

  public func validate(podId: String, requestId: String, expected: RepairContinuationRequestV1? = nil) throws {
    try request.validate(); try RepairWire.refusals(refusals)
    try RepairWire.require(RepairWire.id(operationId) && version == 1 && intent == "qualify_then_code_once" && self.podId == podId
      && request.id == requestId && originalGeneration == request.expectedGeneration && (expected == nil || expected == request)
      && (candidateGeneration == nil || RepairWire.generation(candidateGeneration!)) && RepairWire.date(createdAt) != nil
      && RepairWire.date(updatedAt) != nil && originalResourcesRetained && requiresHumanApproval && !publicationAuthorized)
    if let qualification {
      try qualification.validate()
      let binding = qualification.binding
      try RepairWire.require(binding.operationId == operationId && binding.custodyId == operationId && binding.podId == podId && binding.originalGeneration == request.expectedGeneration
        && binding.originalResultHash == request.expectedResultHash && binding.reportSetHash == request.expectedReportSetHash
        && binding.replacementLaunchDigest == request.expectedExecutionDigest && binding.source.head == request.sourceHead
        && binding.candidateGeneration == candidateGeneration)
    }
    if let final = codingFinalSource {
      try final.validate()
      guard let input = qualification?.binding.source else { throw RepairWire.error }
      try RepairWire.require(final.operationId == operationId && final.selectedHead == request.sourceHead && final.generation == candidateGeneration
        && final.source.repository.utf8.elementsEqual(input.repository.utf8)
        && final.source.baseCommitSha == input.baseCommitSha)
    }
    try RepairWire.require((codingAdmission != .consumed && state != .qualified) || qualification?.outcome == .qualified)
    try RepairWire.require(codingFinalSource == nil || codingAdmission == .consumed)
    try RepairWire.require(![.coding, .sealing, .checking, .validated].contains(state) || codingAdmission == .consumed)
    try RepairWire.require([.notStarted, .unknown].contains(checks) || codingFinalSource != nil)
    try RepairWire.require(state != .validated || (checks == .passed && codingFinalSource != nil))
  }
}

/// Exact canonicalConfiguration subset for the STRICT v1 binding schema:
/// objects, strings, and integers in [0, Number.MAX_SAFE_INTEGER] only.
/// Resource floats live in display/requirements, not this hashed binding. Reject
/// arrays/null/bools/floats/unknown fields rather than silently round or drop them.
/// JSONDecoder rejects unpaired surrogates; no identity is inferred for such input.
indirect enum RepairBindingCanonicalJSON: Decodable {
  case object([String: Self]), string(String), integer(Int)

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let object = try? c.decode([String: Self].self) { self = .object(object) }
    else if let string = try? c.decode(String.self) { self = .string(string) }
    else if let integer = try? c.decode(Int.self), RepairWire.generation(integer) { self = .integer(integer) }
    else { throw RepairWire.error }
  }
  var canonical: String {
    switch self {
    case .integer(let value): return String(value)
    case .string(let value): return Self.quote(value)
    case .object(let fields):
      let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
      return "{" + keys.map { Self.quote($0) + ":" + fields[$0]!.canonical }.joined(separator: ",") + "}"
    }
  }
  var digest: String {
    SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private static func quote(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22: result += "\\\""
      case 0x5c: result += "\\\\"
      case 0x08: result += "\\b"
      case 0x09: result += "\\t"
      case 0x0a: result += "\\n"
      case 0x0c: result += "\\f"
      case 0x0d: result += "\\r"
      case 0..<0x20: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }
  func validateBindingShape() throws {
    guard case .object(let fields) = self,
      case .object(let source) = fields["source"],
      case .object(let image) = fields["expectedImage"] else { throw RepairWire.error }
    try RepairWire.require(Set(fields.keys) == Set([
      "version", "operationId", "requestHash", "podId", "taskId", "executionId", "custodyId",
      "originalGeneration", "candidateGeneration", "originalResultHash", "reportSetHash",
      "requirementsHash", "originalLaunchDigest", "replacementLaunchDigest", "configurationHash",
      "sourceEpoch", "credentialEpoch", "resourceEpoch", "source", "target", "containerId",
      "resourceKey", "expectedImage", "platform", "executionContextHash"
    ]) && Set(source.keys) == Set(["repository", "head", "tree", "baseCommitSha"])
      && Set(image.keys) == Set(["kind", "digest"]))
  }
}

private enum RepairWire {
  static var error: DaemonError { .decodingError("Unsupported or uncorrelated repair-continuation response. No qualification or coding inferred; observe the saved request.") }
  static func require(_ valid: Bool) throws { if !valid { throw error } }
  static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
  static func hash(_ value: String) -> Bool { matches(value, "^[a-f0-9]{64}$") }
  static func sha(_ value: String) -> Bool { matches(value, "^(?:[a-f0-9]{40}|[a-f0-9]{64})$") }
  static func id(_ value: String) -> Bool { value.utf16.count <= 128 && matches(value, "^[A-Za-z0-9][A-Za-z0-9_.:-]*$") }
  static func generation(_ value: Int) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }
  static func date(_ value: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
  static func refusals(_ values: [RepairContinuationRefusal]) throws {
    try require(values.count <= 32); for value in values { try value.validate() }
  }
}

/// Existing first-phase display projection; no source/resource/qualification authority.
public struct RepairRetainedContext: Decodable, Sendable {
  public let inspection: Inspection?
  public struct Inspection: Decodable, Sendable {
    public let infrastructure: Infrastructure
    public let prerequisites: Prerequisites
  }
  public struct Infrastructure: Decodable, Sendable {
    public let state: String
    public let truncated: Bool
    public let needs: [Need]
  }
  public struct Need: Decodable, Sendable {
    public let id: String
    public let owner: String?
    public let phase: String?
    public let needs: String?
    public let truncated: Bool
  }
  public struct Prerequisites: Decodable, Sendable {
    public let sourcePreservationRecorded: Bool
    public let workerSettlementRecorded: Bool
    public let pendingDecision: Bool
  }
}
