import Foundation

// MARK: - Top-level response

public struct SafetyAnalyticsResponse: Decodable, Equatable, Sendable {
    public let summary: SafetyAnalyticsSummary
    public let byPattern: [SafetyPatternCount]
    public let bySource: [SafetySourceCount]
    public let firewallDenials: SafetyFirewallDenials
    public let worktreeSafety: SafetyWorktreeSafety
    public let quarantineHistogram: [SafetyHistogramBucket]
    public let byPod: [SafetyPodEntry]
    public let networkPolicy: [SafetyNetworkPolicyCount]
    public let auditChain: SafetyAuditChainStatus
}

// MARK: - Summary

public struct SafetyAnalyticsSummary: Decodable, Equatable, Sendable {
    public let totalEvents: Int
    public let byKind: SafetyKindCounts
    public let quarantineCount: Int
    public let quarantineHighRiskCount: Int
    public let sparkline: [SafetySparklinePoint]
    public let deltaVsPrior: SafetyDelta
}

public struct SafetyKindCounts: Decodable, Equatable, Sendable {
    public let pii: Int
    public let injection: Int
}

public struct SafetySparklinePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let count: Int
}

public struct SafetyDelta: Decodable, Equatable, Sendable {
    public let value: Int
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - By-pattern

public enum SafetyEventKind: String, Decodable, CaseIterable, Sendable {
    case pii, injection
}

public struct SafetyPatternCount: Decodable, Equatable, Sendable {
    public let kind: SafetyEventKind
    public let patternName: String
    public let count: Int
}

// MARK: - By-source

public enum SafetyEventSource: String, Decodable, CaseIterable, Sendable {
    case actionResponse = "action_response"
    case mcpProxy = "mcp_proxy"
    case issueBody = "issue_body"
    case claudeMdSection = "claude_md_section"
    case skillContent = "skill_content"
    case podInput = "pod_input"
    case eventPayload = "event_payload"
}

public struct SafetySourceCount: Decodable, Equatable, Sendable {
    public let source: SafetyEventSource
    public let count: Int
}

// MARK: - Firewall denials

public struct SafetyFirewallDenials: Decodable, Equatable, Sendable {
    public let total: Int
    public let affectedPods: Int
    public let topHosts: [SafetyFirewallHost]
    public let recent: [SafetyFirewallDenial]
}

public struct SafetyFirewallHost: Decodable, Equatable, Sendable {
    public let sni: String
    public let count: Int
    public let lastDeniedAt: String
}

public struct SafetyFirewallDenial: Decodable, Equatable, Identifiable, Sendable {
    public let podId: String
    public let sni: String
    public let src: String
    public let deniedAt: String

    public var id: String { "\(podId)|\(sni)|\(src)|\(deniedAt)" }
}

// MARK: - Worktree safety

public struct SafetyWorktreeSafety: Decodable, Equatable, Sendable {
    public let currentCompromisedPods: Int
    public let totalIncidents: Int
    public let recentIncidents: [SafetyWorktreeIncident]
}

public struct SafetyWorktreeIncident: Decodable, Equatable, Identifiable, Sendable {
    public let podId: String
    public let deletionCount: Int
    public let threshold: Int
    public let detectedAt: String

    public var id: String { "\(podId)|\(deletionCount)|\(threshold)|\(detectedAt)" }
}

// MARK: - Quarantine histogram

public struct SafetyHistogramBucket: Decodable, Equatable, Sendable {
    /// e.g. "0.0-0.1", "0.1-0.2", …, "0.9-1.0"
    public let bucket: String
    public let count: Int
}

// MARK: - By-pod

public struct SafetyPodEntry: Decodable, Equatable, Sendable {
    /// Either a real pod id or "__pre_creation__".
    public let podId: String
    public let profile: String?
    public let eventCount: Int
    /// ISO 8601 timestamp.
    public let lastEventAt: String
    public let topInjections: [SafetyInjectionEntry]
}

public struct SafetyInjectionEntry: Decodable, Equatable, Sendable {
    public let patternName: String
    /// nil for PII rows.
    public let severity: Double?
    /// <= 256 chars, post-sanitize. nil when source has no text context.
    public let payloadExcerpt: String?
    public let createdAt: String
}

// MARK: - Network policy

public enum NetworkPolicyBucket: String, Decodable, CaseIterable, Sendable {
    case allowAll = "allow-all"
    case restricted
    case denyAll = "deny-all"
    case unknown
}

public struct SafetyNetworkPolicyCount: Decodable, Equatable, Sendable {
    public let bucket: NetworkPolicyBucket
    public let count: Int

    public init(bucket: NetworkPolicyBucket, count: Int) {
        self.bucket = bucket
        self.count = count
    }
}

// MARK: - Audit chain

public struct SafetyAuditChainStatus: Decodable, Equatable, Sendable {
    public let lastVerifiedAt: String?
    /// nil when no verification has ever been run.
    public let valid: Bool?
    public let totalPods: Int?
    public let totalEntries: Int?
    public let firstMismatch: SafetyAuditMismatch?
}

public struct SafetyAuditMismatch: Decodable, Equatable, Sendable {
    public let podId: String
    public let rowId: Int
    public let reason: String
}

// MARK: - Audit chain verify response

public struct AuditChainVerifyResponse: Decodable, Equatable, Sendable {
    public let valid: Bool
    public let totalPods: Int
    public let totalEntries: Int
    public let firstMismatch: SafetyAuditMismatch?
    public let ranAt: String
}
