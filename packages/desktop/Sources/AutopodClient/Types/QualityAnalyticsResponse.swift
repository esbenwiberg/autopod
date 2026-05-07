import Foundation

// MARK: - Top-level response

public struct QualityAnalyticsResponse: Decodable, Equatable, Sendable {
    public let summary: QualityAnalyticsSummary
    public let sparkline: [QualitySparklinePoint]
    /// Always 10 entries: "0-9", "10-19", ..., "90-100".
    public let distribution: [QualityDistributionBucket]
    public let reasons: QualityReasons
    public let scores: [PodQualityScore]
}

// MARK: - Summary

public struct QualityAnalyticsSummary: Decodable, Equatable, Sendable {
    public let totalPodsScored: Int
    public let avgScore: Double
    /// Pods with score < 60.
    public let redCount: Int
    /// Pods with score 60–79.
    public let yellowCount: Int
    /// Pods with score 80+.
    public let greenCount: Int
    public let deltaVsPrior: QualityDelta
}

// MARK: - Delta

public struct QualityDelta: Decodable, Equatable, Sendable {
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - Sparkline

public struct QualitySparklinePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let avgScore: Double
    public let podCount: Int
}

// MARK: - Distribution

public struct QualityDistributionBucket: Decodable, Equatable, Sendable {
    /// e.g. "0-9", "10-19", …, "90-100"
    public let bucket: String
    public let count: Int
}

// MARK: - Reasons

public struct QualityReasons: Decodable, Equatable, Sendable {
    /// readEditRatio < 1 AND editCount > 0
    public let lowReadEditRatio: Int
    /// editsWithoutPriorRead > 0
    public let editsWithoutPriorRead: Int
    /// userInterrupts > 0
    public let userInterrupts: Int
    /// validationPassed === false
    public let validationFailed: Int
    /// prFixAttempts > 0
    public let prFixAttempts: Int
    /// editChurnCount > 0
    public let editChurn: Int
    /// tellsCount > 0
    public let tells: Int

    public init(
        lowReadEditRatio: Int,
        editsWithoutPriorRead: Int,
        userInterrupts: Int,
        validationFailed: Int,
        prFixAttempts: Int,
        editChurn: Int,
        tells: Int
    ) {
        self.lowReadEditRatio = lowReadEditRatio
        self.editsWithoutPriorRead = editsWithoutPriorRead
        self.userInterrupts = userInterrupts
        self.validationFailed = validationFailed
        self.prFixAttempts = prFixAttempts
        self.editChurn = editChurn
        self.tells = tells
    }
}
