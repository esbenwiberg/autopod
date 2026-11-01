import AutopodClient
import Foundation

public struct SandboxRecoveryActions: Sendable {
  public let scope: String
  public let available: Bool
  public let load: @MainActor @Sendable (String) async throws -> SandboxRecoveryState
  public let submit: @MainActor @Sendable (String, SandboxRecoveryRequest) async throws -> SandboxRecoveryResult

  public init(scope: String, available: Bool = true,
              load: @escaping @MainActor @Sendable (String) async throws -> SandboxRecoveryState,
              submit: @escaping @MainActor @Sendable (String, SandboxRecoveryRequest) async throws -> SandboxRecoveryResult) {
    self.scope = scope; self.available = available; self.load = load; self.submit = submit
  }

  public static let unavailable = SandboxRecoveryActions(scope: "unavailable", available: false,
    load: { _ in throw URLError(.unsupportedURL) },
    submit: { _, _ in throw URLError(.unsupportedURL) })
}
