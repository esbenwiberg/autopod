import Foundation

// MARK: - Top-level response

public struct ThroughputAnalyticsResponse: Decodable, Equatable, Sendable {
    public let summary: ThroughputSummary
    public let cohort: [ThroughputCohortPod]
    public let cohortTruncated: Bool
    public let queueDepth: [QueueDepthBucket]
    public let timeInStatus: [TimeInStatusBox]
}

// MARK: - Summary

public struct ThroughputSummary: Decodable, Equatable, Sendable {
    /// Mean pods-per-day = |terminal cohort| / days. 0 when cohort is empty.
    public let podsPerDay: Double
    /// One entry per day in window; length always equals `days`.
    public let podsPerDaySparkline: [ThroughputSparklinePoint]
    public let podsPerDayDelta: ThroughputDelta
    /// Mean time-to-merge in seconds, complete pods only. 0 when none in window.
    public let mttmSeconds: Double
    /// Live point-in-time count: pods with status IN ('queued','provisioning').
    public let backlog: Int
}

public struct ThroughputSparklinePoint: Decodable, Equatable, Sendable {
    /// "YYYY-MM-DD"
    public let day: String
    public let count: Int
}

public struct ThroughputDelta: Decodable, Equatable, Sendable {
    /// Signed difference in mean pods/day vs the immediately-prior window.
    public let value: Double
    public let direction: Direction

    public enum Direction: String, Decodable, Sendable {
        case up, down, flat
    }
}

// MARK: - Cohort

public struct ThroughputCohortPod: Decodable, Equatable, Sendable {
    public let podId: String
    public let profile: String
    public let status: ThroughputPodStatus
    /// ISO UTC. Desktop buckets into local-TZ hour×day.
    public let completedAt: String
}

public enum ThroughputPodStatus: String, Decodable, Sendable {
    case complete, killed, failed
}

// MARK: - Queue depth

public struct QueueDepthBucket: Decodable, Equatable, Sendable {
    /// ISO UTC hour boundary e.g. '2026-05-09T14:00:00Z'.
    public let hour: String
    /// Max queue depth observed during this hour.
    public let max: Double
    /// Mean queue depth during this hour (60 minute-boundary samples).
    public let mean: Double
}

// MARK: - Time in status

public struct TimeInStatusBox: Decodable, Equatable, Sendable {
    public let status: LoadBearingStatus
    /// p25/p50/p75 form the box, p90 is the whisker end, max is the outlier marker. Seconds.
    public let p25: Double
    public let p50: Double
    public let p75: Double
    public let p90: Double
    public let max: Double
    public let sampleCount: Int
}

/// The four states pods spend meaningful time in; excludes the 12 transitional PodStatus values.
public enum LoadBearingStatus: String, Decodable, CaseIterable, Sendable {
    case queued
    case running
    case validating
    case awaitingInput = "awaiting_input"
}
