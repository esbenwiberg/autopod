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

  /// Lenient decode: an unknown `polarity` string degrades to `nil`, and a
  /// non-string `hint` degrades to `nil`, rather than failing the whole row.
  /// Historically neither field was validated on write, so stale rows can carry
  /// values outside the current schema — an unknown polarity (e.g. "pass-on-200"
  /// from earlier spec drafts) or a `hint` that a brief's YAML parser mangled
  /// into an object when the shell command contained unescaped quotes. One bad
  /// Legacy criteria should not blank the entire pod list.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.id = UUID()
    self.type = try c.decode(AcType.self, forKey: .type)
    self.outcome = try c.decode(String.self, forKey: .outcome)
    self.hint = (try? c.decodeIfPresent(String.self, forKey: .hint)) ?? nil
    if let raw = try c.decodeIfPresent(String.self, forKey: .polarity) {
      self.polarity = AcPolarity(rawValue: raw)
    } else {
      self.polarity = nil
    }
  }
}
