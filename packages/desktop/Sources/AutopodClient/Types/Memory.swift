import Foundation

// MARK: - Memory (mirrors packages/shared/src/types/memory.ts)

public enum MemoryScope: Hashable, Sendable, Codable, CaseIterable {
  case global
  case profile
  case pod
  case unknown(String)

  public static var allCases: [MemoryScope] {
    [.global, .profile, .pod]
  }

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "global": self = .global
    case "profile": self = .profile
    case "pod": self = .pod
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .global: "global"
    case .profile: "profile"
    case .pod: "pod"
    case .unknown(let value): value
    }
  }

  public var label: String {
    switch self {
    case .global: "Global"
    case .profile: "Profile"
    case .pod: "Pod"
    case .unknown(let value): value
    }
  }
}

public enum MemoryKind: Equatable, Sendable, Codable {
  case convention
  case gotcha
  case workflow
  case dependency
  case preference
  case reviewFeedback
  case other
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "convention": self = .convention
    case "gotcha": self = .gotcha
    case "workflow": self = .workflow
    case "dependency": self = .dependency
    case "preference": self = .preference
    case "review_feedback": self = .reviewFeedback
    case "other": self = .other
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .convention: "convention"
    case .gotcha: "gotcha"
    case .workflow: "workflow"
    case .dependency: "dependency"
    case .preference: "preference"
    case .reviewFeedback: "review_feedback"
    case .other: "other"
    case .unknown(let value): value
    }
  }
}

public enum MemoryEvidenceSeverity: Equatable, Sendable, Codable {
  case low
  case medium
  case high
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "low": self = .low
    case "medium": self = .medium
    case "high": self = .high
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .low: "low"
    case .medium: "medium"
    case .high: "high"
    case .unknown(let value): value
    }
  }
}

public struct MemorySourceEvidence: Equatable, Sendable, Codable {
  public let podId: String?
  public let signal: String
  public let excerpt: String
  public let severity: MemoryEvidenceSeverity?
  public let createdAt: String?

  public init(
    podId: String? = nil,
    signal: String,
    excerpt: String,
    severity: MemoryEvidenceSeverity? = nil,
    createdAt: String? = nil
  ) {
    self.podId = podId
    self.signal = signal
    self.excerpt = excerpt
    self.severity = severity
    self.createdAt = createdAt
  }

  private enum CodingKeys: String, CodingKey {
    case podId, signal, excerpt, severity, createdAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    podId = try container.decodeIfPresent(String.self, forKey: .podId)
    signal = try container.decodeIfPresent(String.self, forKey: .signal) ?? ""
    excerpt = try container.decodeIfPresent(String.self, forKey: .excerpt) ?? ""
    severity = try container.decodeIfPresent(MemoryEvidenceSeverity.self, forKey: .severity)
    createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
  }
}

public struct MemoryEntry: Identifiable, Sendable, Codable {
  public let id: String
  public let scope: MemoryScope
  public let scopeId: String?
  public let path: String
  public let content: String
  public let contentSha256: String
  public let rationale: String?
  public let kind: MemoryKind?
  public let tags: [String]
  public let appliesWhen: String?
  public let avoidWhen: String?
  public let confidence: Double?
  public let sourceEvidence: [MemorySourceEvidence]
  public let impactSummary: String?
  public let version: Int
  public let approved: Bool
  public let createdByPodId: String?
  public let createdBySessionId: String?
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    scope: MemoryScope,
    scopeId: String? = nil,
    path: String,
    content: String,
    contentSha256: String = "",
    rationale: String? = nil,
    kind: MemoryKind? = nil,
    tags: [String] = [],
    appliesWhen: String? = nil,
    avoidWhen: String? = nil,
    confidence: Double? = nil,
    sourceEvidence: [MemorySourceEvidence] = [],
    impactSummary: String? = nil,
    version: Int = 1,
    approved: Bool = false,
    createdByPodId: String? = nil,
    createdBySessionId: String? = nil,
    createdAt: String = "",
    updatedAt: String = ""
  ) {
    self.id = id
    self.scope = scope
    self.scopeId = scopeId
    self.path = path
    self.content = content
    self.contentSha256 = contentSha256
    self.rationale = rationale
    self.kind = kind
    self.tags = tags
    self.appliesWhen = appliesWhen
    self.avoidWhen = avoidWhen
    self.confidence = confidence
    self.sourceEvidence = sourceEvidence
    self.impactSummary = impactSummary
    self.version = version
    self.approved = approved
    self.createdByPodId = createdByPodId ?? createdBySessionId
    self.createdBySessionId = createdBySessionId ?? createdByPodId
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, scope, scopeId, path, content, contentSha256, rationale
    case kind, tags, appliesWhen, avoidWhen, confidence, sourceEvidence, impactSummary
    case version, approved, createdByPodId, createdBySessionId, createdAt, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    scope = try container.decode(MemoryScope.self, forKey: .scope)
    scopeId = try container.decodeIfPresent(String.self, forKey: .scopeId)
    path = try container.decode(String.self, forKey: .path)
    content = try container.decode(String.self, forKey: .content)
    contentSha256 = try container.decodeIfPresent(String.self, forKey: .contentSha256) ?? ""
    rationale = try container.decodeIfPresent(String.self, forKey: .rationale)
    kind = try container.decodeIfPresent(MemoryKind.self, forKey: .kind)
    tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
    appliesWhen = try container.decodeIfPresent(String.self, forKey: .appliesWhen)
    avoidWhen = try container.decodeIfPresent(String.self, forKey: .avoidWhen)
    confidence = try container.decodeIfPresent(Double.self, forKey: .confidence)
    sourceEvidence = try container.decodeIfPresent([MemorySourceEvidence].self, forKey: .sourceEvidence) ?? []
    impactSummary = try container.decodeIfPresent(String.self, forKey: .impactSummary)
    version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
    approved = try container.decodeIfPresent(Bool.self, forKey: .approved) ?? false
    let podId = try container.decodeIfPresent(String.self, forKey: .createdByPodId)
    let sessionId = try container.decodeIfPresent(String.self, forKey: .createdBySessionId)
    createdByPodId = podId ?? sessionId
    createdBySessionId = sessionId ?? podId
    createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
  }
}

public enum MemoryCandidateAction: Equatable, Sendable, Codable {
  case create
  case update
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "create": self = .create
    case "update": self = .update
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .create: "create"
    case .update: "update"
    case .unknown(let value): value
    }
  }
}

public enum MemoryCandidateStatus: Equatable, Sendable, Codable {
  case pending
  case approved
  case rejected
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "pending": self = .pending
    case "approved": self = .approved
    case "rejected": self = .rejected
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .pending: "pending"
    case .approved: "approved"
    case .rejected: "rejected"
    case .unknown(let value): value
    }
  }

  public var queryValue: String { rawValue }
}

public struct MemoryCandidate: Identifiable, Equatable, Sendable, Codable {
  public let id: String
  public let action: MemoryCandidateAction
  public let targetMemoryId: String?
  public let scope: MemoryScope
  public let scopeId: String
  public let path: String
  public let content: String
  public let rationale: String?
  public let kind: MemoryKind
  public let tags: [String]
  public let appliesWhen: String?
  public let avoidWhen: String?
  public let confidence: Double
  public let sourceEvidence: [MemorySourceEvidence]
  public let impactSummary: String
  public let status: MemoryCandidateStatus
  public let createdByPodId: String?
  public let fallbackReason: String?
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    action: MemoryCandidateAction,
    targetMemoryId: String?,
    scope: MemoryScope,
    scopeId: String,
    path: String,
    content: String,
    rationale: String?,
    kind: MemoryKind,
    tags: [String],
    appliesWhen: String?,
    avoidWhen: String?,
    confidence: Double,
    sourceEvidence: [MemorySourceEvidence],
    impactSummary: String,
    status: MemoryCandidateStatus,
    createdByPodId: String?,
    fallbackReason: String?,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.action = action
    self.targetMemoryId = targetMemoryId
    self.scope = scope
    self.scopeId = scopeId
    self.path = path
    self.content = content
    self.rationale = rationale
    self.kind = kind
    self.tags = tags
    self.appliesWhen = appliesWhen
    self.avoidWhen = avoidWhen
    self.confidence = confidence
    self.sourceEvidence = sourceEvidence
    self.impactSummary = impactSummary
    self.status = status
    self.createdByPodId = createdByPodId
    self.fallbackReason = fallbackReason
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, action, targetMemoryId, scope, scopeId, path, content, rationale
    case kind, tags, appliesWhen, avoidWhen, confidence, sourceEvidence, impactSummary
    case status, createdByPodId, fallbackReason, createdAt, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    action = try container.decodeIfPresent(MemoryCandidateAction.self, forKey: .action) ?? .create
    targetMemoryId = try container.decodeIfPresent(String.self, forKey: .targetMemoryId)
    scope = try container.decodeIfPresent(MemoryScope.self, forKey: .scope) ?? .profile
    scopeId = try container.decodeIfPresent(String.self, forKey: .scopeId) ?? ""
    path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
    content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
    rationale = try container.decodeIfPresent(String.self, forKey: .rationale)
    kind = try container.decodeIfPresent(MemoryKind.self, forKey: .kind) ?? .other
    tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
    appliesWhen = try container.decodeIfPresent(String.self, forKey: .appliesWhen)
    avoidWhen = try container.decodeIfPresent(String.self, forKey: .avoidWhen)
    confidence = try container.decodeIfPresent(Double.self, forKey: .confidence) ?? 0
    sourceEvidence = try container.decodeIfPresent([MemorySourceEvidence].self, forKey: .sourceEvidence) ?? []
    impactSummary = try container.decodeIfPresent(String.self, forKey: .impactSummary) ?? ""
    status = try container.decodeIfPresent(MemoryCandidateStatus.self, forKey: .status) ?? .pending
    createdByPodId = try container.decodeIfPresent(String.self, forKey: .createdByPodId)
    fallbackReason = try container.decodeIfPresent(String.self, forKey: .fallbackReason)
    createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
  }
}

public struct MemoryCandidateUpdate: Equatable, Sendable, Codable {
  public let path: String?
  public let content: String?
  public let rationale: String?
  public let kind: MemoryKind?
  public let tags: [String]?
  public let appliesWhen: String?
  public let avoidWhen: String?
  public let confidence: Double?
  public let sourceEvidence: [MemorySourceEvidence]?
  public let impactSummary: String?

  public init(
    path: String? = nil,
    content: String? = nil,
    rationale: String? = nil,
    kind: MemoryKind? = nil,
    tags: [String]? = nil,
    appliesWhen: String? = nil,
    avoidWhen: String? = nil,
    confidence: Double? = nil,
    sourceEvidence: [MemorySourceEvidence]? = nil,
    impactSummary: String? = nil
  ) {
    self.path = path
    self.content = content
    self.rationale = rationale
    self.kind = kind
    self.tags = tags
    self.appliesWhen = appliesWhen
    self.avoidWhen = avoidWhen
    self.confidence = confidence
    self.sourceEvidence = sourceEvidence
    self.impactSummary = impactSummary
  }
}

public enum MemoryExtractionAttemptStatus: Equatable, Sendable, Codable {
  case candidateCreated
  case belowThreshold
  case reviewerUnavailable
  case reviewerFailed
  case invalidResponse
  case noCandidate
  case skipped
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "candidate_created": self = .candidateCreated
    case "below_threshold": self = .belowThreshold
    case "reviewer_unavailable": self = .reviewerUnavailable
    case "reviewer_failed": self = .reviewerFailed
    case "invalid_response": self = .invalidResponse
    case "no_candidate": self = .noCandidate
    case "skipped": self = .skipped
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .candidateCreated: "candidate_created"
    case .belowThreshold: "below_threshold"
    case .reviewerUnavailable: "reviewer_unavailable"
    case .reviewerFailed: "reviewer_failed"
    case .invalidResponse: "invalid_response"
    case .noCandidate: "no_candidate"
    case .skipped: "skipped"
    case .unknown(let value): value
    }
  }

  public var label: String {
    switch self {
    case .candidateCreated: "Candidate created"
    case .belowThreshold: "Below threshold"
    case .reviewerUnavailable: "Reviewer unavailable"
    case .reviewerFailed: "Reviewer failed"
    case .invalidResponse: "Invalid response"
    case .noCandidate: "No candidate"
    case .skipped: "Skipped"
    case .unknown(let value): value
    }
  }
}

public struct MemoryExtractionAttempt: Identifiable, Equatable, Sendable, Codable {
  public let id: String
  public let podId: String
  public let profileName: String
  public let status: MemoryExtractionAttemptStatus
  public let reason: String
  public let score: Double?
  public let signals: [String]
  public let candidateId: String?
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    podId: String,
    profileName: String,
    status: MemoryExtractionAttemptStatus,
    reason: String,
    score: Double? = nil,
    signals: [String] = [],
    candidateId: String? = nil,
    createdAt: String = "",
    updatedAt: String = ""
  ) {
    self.id = id
    self.podId = podId
    self.profileName = profileName
    self.status = status
    self.reason = reason
    self.score = score
    self.signals = signals
    self.candidateId = candidateId
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public enum MemoryUsageKind: Equatable, Sendable, Codable {
  case selected
  case injected
  case read
  case searched
  case planReported
  case summaryReported
  case notReported
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "selected": self = .selected
    case "injected": self = .injected
    case "read": self = .read
    case "searched": self = .searched
    case "plan_reported": self = .planReported
    case "summary_reported": self = .summaryReported
    case "not_reported": self = .notReported
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .selected: "selected"
    case .injected: "injected"
    case .read: "read"
    case .searched: "searched"
    case .planReported: "plan_reported"
    case .summaryReported: "summary_reported"
    case .notReported: "not_reported"
    case .unknown(let value): value
    }
  }
}

public enum MemoryUsageOutcome: Equatable, Sendable, Codable {
  case intended
  case applied
  case notApplicable
  case harmfulStale
  case unknown(String)

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case "intended": self = .intended
    case "applied": self = .applied
    case "not_applicable": self = .notApplicable
    case "harmful_stale": self = .harmfulStale
    default: self = .unknown(value)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .intended: "intended"
    case .applied: "applied"
    case .notApplicable: "not_applicable"
    case .harmfulStale: "harmful_stale"
    case .unknown(let value): value
    }
  }
}

public struct MemoryUsageEvent: Identifiable, Equatable, Sendable, Codable {
  public let id: String
  public let memoryId: String
  public let podId: String
  public let kind: MemoryUsageKind
  public let outcome: MemoryUsageOutcome?
  public let reason: String?
  public let relevanceReason: String?
  public let createdAt: String
}

public struct MemoryUsageResponse: Equatable, Sendable, Codable {
  public let memoryId: String
  public let events: [MemoryUsageEvent]
}

public struct MemoryEvidenceResponse: Equatable, Sendable, Codable {
  public let memoryId: String?
  public let candidateId: String?
  public let evidence: [MemorySourceEvidence]

  public init(
    memoryId: String? = nil,
    candidateId: String? = nil,
    evidence: [MemorySourceEvidence]
  ) {
    self.memoryId = memoryId
    self.candidateId = candidateId
    self.evidence = evidence
  }
}

public struct MemoryStaleEvidenceResponse: Equatable, Sendable, Codable {
  public let memoryId: String
  public let evidence: [MemoryUsageEvent]
}

public typealias MemorySourceEvidenceResponse = MemoryEvidenceResponse
public typealias MemoryUsageEvidenceResponse = MemoryStaleEvidenceResponse
