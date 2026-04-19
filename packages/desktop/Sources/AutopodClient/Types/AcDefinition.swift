import Foundation

/// Structured acceptance criterion. Mirrors `AcDefinition` in
/// `packages/shared/src/types/ac.ts`. Callers pass these to both the
/// create-pod and create-series endpoints so the daemon can validate each
/// criterion at the right tier (api / web / none).
public struct AcDefinition: Codable, Sendable, Hashable, Identifiable {
  public enum AcType: String, Codable, CaseIterable, Sendable {
    case none, api, web

    public var label: String {
      switch self {
      case .none: "None"
      case .api:  "API"
      case .web:  "Web"
      }
    }
  }

  // Client-only stable identity for list editing. Excluded from encoding.
  public var id: UUID = UUID()
  public var type: AcType
  /// Criterion description — or the test command/URL for typed criteria.
  public var test: String
  /// Condition that indicates the criterion is satisfied.
  public var pass: String
  /// Condition that indicates the criterion is NOT satisfied.
  public var fail: String

  public init(type: AcType = .none, test: String = "", pass: String = "criterion satisfied", fail: String = "criterion not satisfied") {
    self.type = type
    self.test = test
    self.pass = pass
    self.fail = fail
  }

  /// Convenience — build a structured criterion from a plain string (paste-list
  /// quick-input). Type defaults to `.none`, pass/fail use generic wording.
  public static func fromString(_ s: String) -> AcDefinition {
    AcDefinition(type: .none, test: s, pass: "criterion satisfied", fail: "criterion not satisfied")
  }

  private enum CodingKeys: String, CodingKey {
    case type, test, pass, fail
  }
}
