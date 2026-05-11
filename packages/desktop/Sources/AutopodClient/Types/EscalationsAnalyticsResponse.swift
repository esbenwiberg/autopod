import Foundation

// MARK: - Top-level response

public struct EscalationsAnalyticsResponse: Decodable, Equatable, Sendable {
    public let summary: EscalationsSummary
    public let askHumanTtr: AskHumanTtr
    public let perProfile: [PerProfileEscalation]
    public let blockerPatterns: [BlockerPattern]
}

// MARK: - Summary

public struct EscalationsSummary: Decodable, Equatable, Sendable {
    /// Fraction in [0, 1]. Returns 1.0 when cohortSize == 0.
    public let selfRecoveryRate: Double
    public let cohortSize: Int
    public let humanAttentionPodCount: Int
    /// Total human-attention escalation rows for cohort pods (may exceed humanAttentionPodCount).
    public let humanAttentionCount: Int
    public let askAiCount: Int
    /// One entry per day in window; length always equals `days`.
    public let dailyHumanCountSparkline: [EscalationsSparklinePoint]
    public let selfRecoveryRateDelta: EscalationsRateDelta
}

public struct EscalationsSparklinePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let count: Int
}

public struct EscalationsRateDelta: Decodable, Equatable, Sendable {
    /// Signed difference in selfRecoveryRate vs the prior window, as an absolute fraction.
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - ask_human TTR

public struct AskHumanTtr: Decodable, Equatable, Sendable {
    /// Always 8 entries in the fixed label order.
    public let buckets: [AskHumanTtrBucket]
    public let resolvedCount: Int
    /// Unresolved ask_human escalations created in window, point-in-time at request time.
    public let openCount: Int
    /// Largest resolved TTR in seconds. 0 when resolvedCount == 0.
    public let maxSeconds: Double
}

public struct AskHumanTtrBucket: Decodable, Equatable, Sendable {
    /// One of: "<1m", "1–5m", "5–15m", "15m–1h", "1–4h", "4–12h", "12–24h", ">24h"
    public let label: String
    public let count: Int
}

// MARK: - Per-profile

public struct PerProfileEscalation: Decodable, Equatable, Sendable {
    /// Profile name or the synthetic "<small profiles>" bucket.
    public let profile: String
    public let podCount: Int
    public let escalatedCount: Int
    public let rate: Double
}

// MARK: - Blocker pattern

public struct BlockerPattern: Decodable, Equatable, Sendable {
    /// Verbatim report_blocker description (trimmed, exact-string grouping).
    public let description: String
    public let count: Int
    /// Up to 10 distinct pod IDs, most-recent-first.
    public let podIds: [String]
}
