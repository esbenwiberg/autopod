import Foundation

/// One data point from `GET /pods/quality/trends`.
/// Daily average quality score per runtime/model over the trailing N days.
public struct QualityTrend: Codable, Sendable, Identifiable {
  public let day: String
  public let avgScore: Double
  public let podCount: Int
  public let runtime: String
  public let model: String?

  public var id: String { "\(day)/\(runtime)/\(model ?? "—")" }
}
