import Foundation

/// Whether retained activity can support inspection-dependent process judgments.
public enum QualityInspectionAvailability: String, Codable, Equatable, Sendable {
  case available
  case unavailable
}

/// Response from GET /pods/:id/quality — per-pod behavioural telemetry
/// derived from the agent event stream plus escalation/pod state.
public struct PodQualitySignals: Codable, Sendable {
  public let podId: String
  public let inspectionAvailability: QualityInspectionAvailability
  public let inspectionUnavailableReason: String?
  public let ambiguousInspectionCount: Int?
  public let readCount: Int?
  public let editCount: Int
  public let modifiedFileCount: Int?
  public let readEditRatio: Double?
  public let editsWithoutPriorRead: Int?
  public let userInterrupts: Int
  /// Distinct files with 3+ modify events — indicates thrashing.
  public let editChurnCount: Int
  /// Stop-phrase/hedging patterns detected in agent output.
  public let tellsCount: Int
  /// Number of PR fix cycles.
  public let prFixAttempts: Int
  /// Whether smoke validation passed (nil = no validation ran).
  public let validationPassed: Bool?
  /// Aggregate of agent-driven `validate_in_browser` MCP calls.
  /// Nil when the agent never invoked the tool.
  public let browserChecks: PodBrowserChecks?
  public let tokens: PodQualityTokens
  public let grade: String  // "green" | "yellow" | "red"
  /// Persisted process-health score (0..100); nil when unavailable or non-terminal.
  public let score: Int?
  /// Exact model string at completion, e.g. "claude-opus-4-7".
  public let model: String?
}

public struct PodQualityTokens: Codable, Sendable {
  public let input: Int
  public let output: Int
  public let costUsd: Double
}

public struct PodBrowserChecks: Codable, Sendable {
  /// Number of `validate_in_browser` invocations.
  public let calls: Int
  /// Sum of individual checks across all invocations.
  public let totalChecks: Int
  /// Sum of passing checks across all invocations.
  public let passedChecks: Int
}
