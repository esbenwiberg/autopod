import Foundation

/// Structured acceptance criterion. Mirrors `AcDefinition` in
/// `packages/shared/src/types/ac.ts`. Callers pass these to both the
/// create-pod and create-series endpoints so the daemon can validate each
/// criterion at the right tier (api / web / none / cmd).
public struct AcDefinition: Codable, Sendable, Hashable, Identifiable {
  public enum AcType: String, Codable, CaseIterable, Sendable {
    case none, api, web, cmd

    public var label: String {
      switch self {
      case .none: "None"
      case .api:  "API"
      case .web:  "Web"
      case .cmd:  "Cmd"
      }
    }
  }

  public enum AcPolarity: String, Codable, CaseIterable, Sendable {
    case expectOutput    = "expect-output"
    case expectNoOutput  = "expect-no-output"
    case exitZero        = "exit-zero"
  }

  // Client-only stable identity for list editing. Excluded from encoding.
  public var id: UUID = UUID()
  public var type: AcType
  /// User-visible criterion description. Always required.
  public var outcome: String
  /// Optional technical pointer (URL path, selector, endpoint, or shell command).
  public var hint: String?
  /// Polarity for cmd-type ACs only.
  public var polarity: AcPolarity?

  public init(type: AcType = .none, outcome: String = "", hint: String? = nil, polarity: AcPolarity? = nil) {
    self.type = type
    self.outcome = outcome
    self.hint = hint
    self.polarity = polarity
  }

  /// Convenience — build a structured criterion from a plain string (paste-list
  /// quick-input). Type defaults to `.none`.
  public static func fromString(_ s: String) -> AcDefinition {
    AcDefinition(type: .none, outcome: s)
  }

  private enum CodingKeys: String, CodingKey {
    case type, outcome, hint, polarity
  }
}
