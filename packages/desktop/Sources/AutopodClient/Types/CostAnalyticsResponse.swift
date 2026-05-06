import Foundation

public struct CostAnalyticsResponse: Decodable, Equatable, Sendable {
    public let total: Double
    public let sparkline: [SparklinePoint]
    public let deltaVsPrior: CostDelta
    public let byPhase: [PhaseSegment]
    public let byProfileModel: [ProfileModelCell]
    public let top10: [TopPodEntry]
    public let waste: WasteSummary
}

public struct SparklinePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let costUsd: Double
}

public struct CostDelta: Decodable, Equatable, Sendable {
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

public struct PhaseSegment: Decodable, Equatable, Sendable {
    /// e.g. "agent_initial", "agent_rework_1", "review", "plan_eval", "agent_legacy"
    public let phase: String
    public let costUsd: Double

    public init(phase: String, costUsd: Double) {
        self.phase = phase
        self.costUsd = costUsd
    }
}

public struct ProfileModelCell: Decodable, Equatable, Sendable {
    public let profile: String
    public let model: String?
    public let costUsd: Double
    public let podCount: Int
}

public struct TopPodEntry: Decodable, Equatable, Sendable {
    public let podId: String
    public let profile: String
    public let model: String?
    /// "complete" | "killed" | "failed" | "rejected"
    public let finalStatus: String
    public let costUsd: Double
    /// ISO 8601 timestamp
    public let completedAt: String
}

public struct WasteSummary: Decodable, Equatable, Sendable {
    public let total: Double
    public let podCount: Int
}
