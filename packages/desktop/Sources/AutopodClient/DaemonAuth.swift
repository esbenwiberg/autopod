import Foundation

public typealias DaemonAccessTokenProvider = @Sendable () async throws -> String

public enum DaemonAuth {
  public static func normalizeBearerToken(_ token: String) -> String {
    let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.lowercased().hasPrefix("bearer ") {
      return String(trimmed.dropFirst("Bearer ".count))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return trimmed
  }
}
