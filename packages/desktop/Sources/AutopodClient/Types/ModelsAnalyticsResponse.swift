import Foundation

// MARK: - Top-level response

public struct ModelsAnalyticsResponse: Decodable, Equatable, Sendable {
    public let summary: ModelsSummary
    /// Sorted by podCount DESC, ties broken by model name ASC.
    public let byModel: [PerModelAggregate]
    /// Always exactly 3 entries in claude / codex / copilot order.
    public let byRuntime: [PerRuntimeAggregate]
    /// One row per canonical model (same sort order as byModel).
    public let failureStageMatrix: [ModelsFailureStageRow]
    /// Up to 10 raw model strings that didn't resolve. Sorted by podCount DESC.
    public let unknownModels: [UnknownModelSample]
}

// MARK: - Summary

public struct ModelsSummary: Decodable, Equatable, Sendable {
    /// Cheapest $/PR canonical model name. Null when no model has >= 5 complete pods.
    public let cheapestDollarPerPrModel: String?
    /// dollarPerPr for cheapestDollarPerPrModel. Null when cheapestDollarPerPrModel is null.
    public let cheapestDollarPerPr: Double?
    /// Canonical model with highest avgQuality across eligible rows. Null when none qualify.
    public let bestQualityModel: String?
    /// avgQuality for bestQualityModel. Null when bestQualityModel is null.
    public let bestQuality: Double?
    /// Canonical model with highest podCount. Null when cohort is empty.
    public let mostUsedModel: String?
    /// podCount for mostUsedModel. Null when mostUsedModel is null.
    public let mostUsedPodCount: Int?
    /// Total distinct terminal-cohort pods over the window.
    public let cohortSize: Int
    /// One entry per day in window (length == days). Empty cohort emits all-zero counts.
    public let mostUsedDailySparkline: [ModelsDailyPoint]
    /// Signed difference in cheapestDollarPerPr vs the prior window (absolute USD).
    public let cheapestDollarPerPrDelta: ModelsDollarDelta
}

public struct ModelsDailyPoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let count: Int
}

public struct ModelsDollarDelta: Decodable, Equatable, Sendable {
    /// Absolute USD (e.g. -0.42 = $0.42 cheaper). 0 when either window has no eligible model.
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - Per-model aggregate

public struct PerModelAggregate: Decodable, Equatable, Sendable {
    /// Canonical model key (post-MODEL_CANONICAL coalescing). "<unknown>" for unpriced pods.
    public let model: String
    public let podCount: Int
    public let completeCount: Int
    public let killedCount: Int
    public let failedCount: Int
    /// completeCount / podCount. In [0, 1].
    public let successRate: Double
    /// SUM(effectiveCostUsd) including killed/failed. Null when model == "<unknown>".
    public let totalCostUsd: Double?
    /// totalCostUsd / completeCount. Null when completeCount == 0 or model == "<unknown>".
    public let dollarPerPr: Double?
    public let scoredCount: Int
    /// Mean of pod_quality_scores.score. Null when scoredCount == 0. In [0, 100].
    public let avgQuality: Double?
    /// Mean (completed_at - created_at) seconds. Null when completeCount == 0.
    public let meanTtmSeconds: Double?
    public let escalatedCount: Int
    /// escalatedCount / podCount. In [0, 1].
    public let escalationRate: Double
    /// Cost from status='complete' pods only. Null when model == "<unknown>".
    public let completeCostUsd: Double?
}

// MARK: - Per-runtime aggregate

public struct PerRuntimeAggregate: Decodable, Equatable, Sendable {
    public let runtime: ModelsRuntimeKind
    public let podCount: Int
    public let completeCount: Int
    public let killedCount: Int
    public let failedCount: Int
    public let successRate: Double
    public let totalCostUsd: Double
    public let dollarPerPr: Double?
    public let scoredCount: Int
    public let avgQuality: Double?
    public let meanTtmSeconds: Double?
    public let escalatedCount: Int
    public let escalationRate: Double
}

/// Runtime engine — exactly 3 values matching the TS RuntimeType union.
public enum ModelsRuntimeKind: String, Decodable, CaseIterable, Sendable {
    case claude, codex, copilot
}

// MARK: - Failure-stage matrix

/// One row per canonical model; stages array always has exactly 8 entries.
public struct ModelsFailureStageRow: Decodable, Equatable, Sendable {
    /// Canonical model key. May be "<unknown>".
    public let model: String
    /// Always 8 entries in the fixed order: build, health, smoke, test, lint, sast, acValidation, taskReview.
    public let stages: [StageFailureRow]
}

// MARK: - Unknown model samples

public struct UnknownModelSample: Decodable, Equatable, Sendable {
    /// Verbatim pods.model string that didn't resolve via MODEL_CANONICAL.
    public let rawModel: String
    /// Distinct cohort pod count carrying this raw model string.
    public let podCount: Int
}
