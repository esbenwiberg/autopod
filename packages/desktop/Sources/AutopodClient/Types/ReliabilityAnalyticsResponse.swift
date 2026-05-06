import Foundation

// MARK: - Top-level response

public struct ReliabilityAnalyticsResponse: Decodable, Equatable, Sendable {
    public let firstPassRate: Double
    public let firstPassRateSparkline: [SparklineRatePoint]
    public let firstPassRateDelta: ReliabilityDelta
    public let funnel: ReliabilityFunnel
    public let stageFailures: [StageFailureRow]
    public let profileHeatmap: [ProfileHeatmapRow]
    public let summary: ReliabilitySummary
}

// MARK: - Sparkline

public struct SparklineRatePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let rate: Double
}

// MARK: - Delta

public struct ReliabilityDelta: Decodable, Equatable, Sendable {
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - Funnel

public struct ReliabilityFunnel: Decodable, Equatable, Sendable {
    public let bands: [BandCount]
    public let drops: [DropEntry]
}

public struct BandCount: Decodable, Equatable, Sendable {
    public let band: FunnelBand
    public let count: Int
}

public enum FunnelBand: String, Decodable, CaseIterable, Sendable {
    case queued, provisioning, running, validating
    case validated, approved, merging, complete
}

public enum FinalStatus: String, Decodable, Sendable {
    case complete, killed, failed
}

public struct DropEntry: Decodable, Equatable, Sendable {
    public let from: FunnelBand
    public let to: FinalStatus
    public let count: Int
    public let topPods: [DropPodEntry]
    public let overflow: Int
}

public struct DropPodEntry: Decodable, Equatable, Sendable {
    public let podId: String
    public let profile: String
    public let finalStatus: FinalStatus
    /// ISO 8601 timestamp
    public let completedAt: String
}

// MARK: - Stage failures

public enum ValidationStage: String, Decodable, CaseIterable, Sendable {
    case build, health, smoke, test, lint, sast, acValidation, taskReview
}

public struct StageFailureRow: Decodable, Equatable, Sendable {
    public let stage: ValidationStage
    public let podsRan: Int
    public let podsFailed: Int
    public let failureRate: Double
}

// MARK: - Profile heatmap

public struct ProfileHeatmapRow: Decodable, Equatable, Sendable {
    public let profile: String
    public let stages: [StageFailureRow]
}

// MARK: - Summary

public struct ReliabilitySummary: Decodable, Equatable, Sendable {
    /// `nil` when no failures observed (server sends empty string).
    public let topFailureStage: ValidationStage?
    public let avgReworkCount: Double
    public let totalPodsInWindow: Int

    enum CodingKeys: String, CodingKey {
        case topFailureStage, avgReworkCount, totalPodsInWindow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .topFailureStage)
        self.topFailureStage = raw.isEmpty ? nil : ValidationStage(rawValue: raw)
        self.avgReworkCount = try c.decode(Double.self, forKey: .avgReworkCount)
        self.totalPodsInWindow = try c.decode(Int.self, forKey: .totalPodsInWindow)
    }
}
