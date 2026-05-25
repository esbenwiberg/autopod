import Foundation

// MARK: - Memory (mirrors packages/shared/src/types/memory.ts)

public enum MemoryScope: String, CaseIterable, Sendable, Codable {
    case global, profile, pod

    public var label: String {
        switch self {
        case .global:  "Global"
        case .profile: "Profile"
        case .pod: "Pod"
        }
    }
}

public enum MemoryKind: Sendable, Codable, Equatable {
    case convention
    case gotcha
    case workflow
    case dependency
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
        case "review_feedback": self = .reviewFeedback
        case "other": self = .other
        default: self = .unknown(value)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .convention: try container.encode("convention")
        case .gotcha: try container.encode("gotcha")
        case .workflow: try container.encode("workflow")
        case .dependency: try container.encode("dependency")
        case .reviewFeedback: try container.encode("review_feedback")
        case .other: try container.encode("other")
        case .unknown(let value): try container.encode(value)
        }
    }
}

public enum MemoryEvidenceSeverity: Sendable, Codable, Equatable {
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
        switch self {
        case .low: try container.encode("low")
        case .medium: try container.encode("medium")
        case .high: try container.encode("high")
        case .unknown(let value): try container.encode(value)
        }
    }
}

public struct MemorySourceEvidence: Sendable, Codable, Equatable {
    public let podId: String
    public let signal: String
    public let excerpt: String
    public let severity: MemoryEvidenceSeverity?
    public let createdAt: String

    public init(
        podId: String,
        signal: String,
        excerpt: String,
        severity: MemoryEvidenceSeverity? = nil,
        createdAt: String
    ) {
        self.podId = podId
        self.signal = signal
        self.excerpt = excerpt
        self.severity = severity
        self.createdAt = createdAt
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
    public var createdBySessionId: String? { createdByPodId }
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String, scope: MemoryScope, scopeId: String? = nil,
        path: String, content: String, contentSha256: String = "",
        rationale: String? = nil,
        kind: MemoryKind? = nil, tags: [String] = [],
        appliesWhen: String? = nil, avoidWhen: String? = nil,
        confidence: Double? = nil, sourceEvidence: [MemorySourceEvidence] = [],
        impactSummary: String? = nil,
        version: Int = 1, approved: Bool = false,
        createdByPodId: String? = nil, createdBySessionId: String? = nil,
        createdAt: String = "", updatedAt: String = ""
    ) {
        self.id = id; self.scope = scope; self.scopeId = scopeId
        self.path = path; self.content = content; self.contentSha256 = contentSha256
        self.rationale = rationale
        self.kind = kind; self.tags = tags
        self.appliesWhen = appliesWhen; self.avoidWhen = avoidWhen
        self.confidence = confidence; self.sourceEvidence = sourceEvidence
        self.impactSummary = impactSummary
        self.version = version; self.approved = approved
        self.createdByPodId = createdByPodId ?? createdBySessionId
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, scope, scopeId, path, content, contentSha256, rationale, kind, tags
        case appliesWhen, avoidWhen, confidence, sourceEvidence, impactSummary
        case version, approved, createdByPodId, createdBySessionId, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scope = try c.decode(MemoryScope.self, forKey: .scope)
        scopeId = try c.decodeIfPresent(String.self, forKey: .scopeId)
        path = try c.decode(String.self, forKey: .path)
        content = try c.decode(String.self, forKey: .content)
        contentSha256 = try c.decodeIfPresent(String.self, forKey: .contentSha256) ?? ""
        rationale = try c.decodeIfPresent(String.self, forKey: .rationale)
        kind = try c.decodeIfPresent(MemoryKind.self, forKey: .kind)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        appliesWhen = try c.decodeIfPresent(String.self, forKey: .appliesWhen)
        avoidWhen = try c.decodeIfPresent(String.self, forKey: .avoidWhen)
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence)
        sourceEvidence = try c.decodeIfPresent(
            [MemorySourceEvidence].self,
            forKey: .sourceEvidence
        ) ?? []
        impactSummary = try c.decodeIfPresent(String.self, forKey: .impactSummary)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        approved = try c.decodeIfPresent(Bool.self, forKey: .approved) ?? false
        createdByPodId = try c.decodeIfPresent(String.self, forKey: .createdByPodId)
            ?? c.decodeIfPresent(String.self, forKey: .createdBySessionId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(scope, forKey: .scope)
        try c.encodeIfPresent(scopeId, forKey: .scopeId)
        try c.encode(path, forKey: .path)
        try c.encode(content, forKey: .content)
        try c.encode(contentSha256, forKey: .contentSha256)
        try c.encodeIfPresent(rationale, forKey: .rationale)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encode(tags, forKey: .tags)
        try c.encodeIfPresent(appliesWhen, forKey: .appliesWhen)
        try c.encodeIfPresent(avoidWhen, forKey: .avoidWhen)
        try c.encodeIfPresent(confidence, forKey: .confidence)
        try c.encode(sourceEvidence, forKey: .sourceEvidence)
        try c.encodeIfPresent(impactSummary, forKey: .impactSummary)
        try c.encode(version, forKey: .version)
        try c.encode(approved, forKey: .approved)
        try c.encodeIfPresent(createdByPodId, forKey: .createdByPodId)
        try c.encodeIfPresent(createdByPodId, forKey: .createdBySessionId)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }
}

public enum MemoryCandidateStatus: Sendable, Codable, Equatable {
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
        switch self {
        case .pending: try container.encode("pending")
        case .approved: try container.encode("approved")
        case .rejected: try container.encode("rejected")
        case .unknown(let value): try container.encode(value)
        }
    }

    public var queryValue: String {
        switch self {
        case .pending: "pending"
        case .approved: "approved"
        case .rejected: "rejected"
        case .unknown(let value): value
        }
    }
}

public enum MemoryCandidateAction: Sendable, Codable, Equatable {
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
        switch self {
        case .create: try container.encode("create")
        case .update: try container.encode("update")
        case .unknown(let value): try container.encode(value)
        }
    }
}

public struct MemoryCandidate: Identifiable, Sendable, Codable, Equatable {
    public let id: String
    public let action: MemoryCandidateAction
    public let targetMemoryId: String?
    public let scope: MemoryScope
    public let scopeId: String
    public let path: String
    public let content: String
    public let rationale: String
    public let kind: MemoryKind
    public let tags: [String]
    public let appliesWhen: String?
    public let avoidWhen: String?
    public let confidence: Double
    public let sourceEvidence: [MemorySourceEvidence]
    public let impactSummary: String
    public let status: MemoryCandidateStatus
    public let createdByPodId: String
    public let fallbackReason: String?
    public let createdAt: String
    public let updatedAt: String
}

public enum MemoryUsageKind: Sendable, Codable, Equatable {
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
        switch self {
        case .selected: try container.encode("selected")
        case .injected: try container.encode("injected")
        case .read: try container.encode("read")
        case .searched: try container.encode("searched")
        case .planReported: try container.encode("plan_reported")
        case .summaryReported: try container.encode("summary_reported")
        case .notReported: try container.encode("not_reported")
        case .unknown(let value): try container.encode(value)
        }
    }
}

public enum MemoryUsageOutcome: Sendable, Codable, Equatable {
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
        switch self {
        case .intended: try container.encode("intended")
        case .applied: try container.encode("applied")
        case .notApplicable: try container.encode("not_applicable")
        case .harmfulStale: try container.encode("harmful_stale")
        case .unknown(let value): try container.encode(value)
        }
    }
}

public struct MemoryUsageEvent: Identifiable, Sendable, Codable, Equatable {
    public let id: String
    public let memoryId: String
    public let podId: String
    public let kind: MemoryUsageKind
    public let outcome: MemoryUsageOutcome?
    public let reason: String?
    public let relevanceReason: String?
    public let createdAt: String
}

public struct MemoryUsageResponse: Sendable, Codable, Equatable {
    public let memoryId: String
    public let events: [MemoryUsageEvent]
}

public struct MemorySourceEvidenceResponse: Sendable, Codable, Equatable {
    public let memoryId: String?
    public let candidateId: String?
    public let evidence: [MemorySourceEvidence]

    public init(memoryId: String? = nil, candidateId: String? = nil, evidence: [MemorySourceEvidence]) {
        self.memoryId = memoryId
        self.candidateId = candidateId
        self.evidence = evidence
    }
}

public struct MemoryUsageEvidenceResponse: Sendable, Codable, Equatable {
    public let memoryId: String
    public let evidence: [MemoryUsageEvent]
}

public struct MemoryCandidateUpdate: Sendable, Codable, Equatable {
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
