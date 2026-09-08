import Foundation

public struct ScheduledScanPolicy: Codable, Sendable, Hashable {
  public let version: Int
  public let baseRef: String
  public let headRef: String
  public let scanners: [String]
  public let judgment: String
  public let windowHours: Int?
  public init(baseRef: String, headRef: String, scanners: [String], judgment: String = "none", windowHours: Int? = nil) {
    self.version = 1; self.baseRef = baseRef; self.headRef = headRef
    self.scanners = scanners; self.judgment = judgment; self.windowHours = windowHours
  }
}
public struct ScheduledRunResponse: Codable, Sendable {
  public let kind: String?
  public let id: String
  public let status: String
  public var isReport: Bool { kind == "scan_report" }
}
public struct ScheduledScanFinding: Codable, Identifiable, Sendable {
  public let id: String
  public let scanner: String
  public let ruleId: String
  public let file: String
  public let line: Int?
  public let severity: String
  public let summary: String
  public let disposition: String?
}
public struct ScheduledScannerResult: Codable, Sendable {
  public let scanner: String
  public let version: String?
  public let status: String
  public let diagnostic: String?
  public let findingCount: Int?
}
public struct ScheduledScanCollection: Codable, Sendable {
  public struct Window: Codable, Sendable { public let start: String; public let end: String; public let semantics: String; public let selectedCommits: [String] }
  public let window: Window?
  public let baseKind: String?
  public struct FileDelta: Codable, Sendable { public let path: String; public let change: String }
  public let repository: String
  public let baseSha: String?
  public let headSha: String?
  public let files: [FileDelta]
  public let stacks: [String]
  public let scanners: [ScheduledScannerResult]
  public let findings: [ScheduledScanFinding]
  public let diagnostics: [String]
}
public struct ScheduledScanReport: Codable, Identifiable, Sendable {
  public struct Judgment: Codable, Sendable {
    public struct Usage: Codable, Sendable {
      public let inputTokens: Int; public let outputTokens: Int; public let costUsd: Double?
      public let durationMs: Double; public let model: String; public let provider: String
      public let providerAccountId: String?
    }
    public let status: String; public let text: String?; public let usage: Usage?
  }
  public let kind: String
  public let id: String
  public let jobId: String
  public let status: String
  public let policy: ScheduledScanPolicy
  public let collection: ScheduledScanCollection?
  public let judgment: Judgment
  public let createdAt: String
  public let completedAt: String?
}
public struct ScanTriageRequest: Codable, Sendable {
  public let requestKey: String
  public let findingIds: [String]
  public let action: String
  public let reason: String
  public init(requestKey: String, findingIds: [String], action: String, reason: String) {
    self.requestKey = requestKey; self.findingIds = findingIds
    self.action = action; self.reason = reason
  }
}
public struct ScanTriageDecision: Codable, Identifiable, Sendable {
  public struct Actor: Codable, Sendable { public let type: String; public let userId: String?; public let displayName: String? }
  public let id: String
  public let findingIds: [String]
  public let action: String
  public let reason: String
  public let actor: Actor
  public let createdAt: String
  public let repairPodId: String?
}
public struct ScanReportDetail: Codable, Sendable {
  public let report: ScheduledScanReport
  public let unresolved: [ScheduledScanFinding]
  public let decisions: [ScanTriageDecision]
}
public struct ScanRepairDispatch: Codable, Sendable {
  public let kind: String
  public let selectionId: String
  public let podId: String
}

public struct ScanReportSummary: Codable, Identifiable, Sendable {
  public let id: String
  public let jobId: String
  public let status: String
  public let createdAt: String
  public let completedAt: String?
  public let findingCount: Int?
  public let judgmentStatus: String?
  public let diagnostics: [String]
}
public struct ScanReportPage: Codable, Sendable {
  public let items: [ScanReportSummary]
  public let nextCursor: String?
}
