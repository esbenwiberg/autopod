import AutopodClient
import Foundation

public struct FileRecoveryActions: Sendable {
  public let scope: String
  public let available: Bool
  public let isFixture: Bool
  public let isCurrent: @MainActor @Sendable () -> Bool
  public let load: @MainActor @Sendable (String, Bool) async throws -> RecoveryFilesSnapshot
  public let read: @MainActor @Sendable (String, RecoveryFileSelection) async throws -> RecoveryFileContent

  public init(scope: String, available: Bool = true, isFixture: Bool = false,
    isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    load: @escaping @MainActor @Sendable (String, Bool) async throws -> RecoveryFilesSnapshot,
    read: @escaping @MainActor @Sendable (String, RecoveryFileSelection) async throws -> RecoveryFileContent) {
    self.scope = scope; self.available = available; self.isFixture = isFixture; self.isCurrent = isCurrent
    self.load = load; self.read = read
  }
  public static let unavailable = FileRecoveryActions(scope: "unavailable", available: false,
    load: { _, _ in throw URLError(.unsupportedURL) }, read: { _, _ in throw URLError(.unsupportedURL) })
}
