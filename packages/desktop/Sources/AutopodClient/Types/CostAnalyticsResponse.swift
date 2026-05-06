import Foundation

public struct CostAnalyticsResponse: Decodable, Equatable {
    public let total: Double
    public let sparkline: [SparklinePoint]
    public let deltaVsPrior: CostDelta
    public let byPhase: [PhaseSegment]
    public let byProfileModel: [ProfileModelCell]
    public let top10: [TopPodEntry]
    public let waste: WasteSummary
}

public struct SparklinePoint: Decodable, Equatable {
    /// "YYYY-MM-DD"
    public let day: String
    public let costUsd: Double
}

public struct CostDelta: Decodable, Equatable {
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable {
        case up, down, flat
    }
}

public struct PhaseSegment: Decodable, Equatable {
    /// e.g. "agent_initial", "agent_rework_1", "review", "plan_eval", "agent_legacy"
    public let phase: String
    public let costUsd: Double
}

public struct ProfileModelCell: Decodable, Equatable {
    public let profile: String
    public let model: String?
    public let costUsd: Double
    public let podCount: Int
}

public struct TopPodEntry: Decodable, Equatable {
    public let podId: String
    public let profile: String
    public let model: String?
    /// "complete" | "killed" | "failed" | "rejected"
    public let finalStatus: String
    public let costUsd: Double
    /// ISO 8601 timestamp
    public let completedAt: String
}

public struct WasteSummary: Decodable, Equatable {
    public let total: Double
    public let podCount: Int
}
