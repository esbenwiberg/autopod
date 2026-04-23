import Foundation

/// One row from `GET /pods/scores` — the persisted quality-score table.
/// Written by the daemon's `QualityScoreRecorder` on `pod.completed`.
public struct PodQualityScore: Codable, Sendable, Identifiable {
  public let podId: String
  public let score: Int
  public let readCount: Int
  public let editCount: Int
  public let readEditRatio: Double
  public let editsWithoutPriorRead: Int
  public let userInterrupts: Int
  public let tellsCount: Int
  public let inputTokens: Int
  public let outputTokens: Int
  public let costUsd: Double
  public let runtime: String
  public let profileName: String
  public let model: String?
  public let finalStatus: String  // "complete" | "killed"
  public let completedAt: String
  public let computedAt: String

  public var id: String { podId }
}
