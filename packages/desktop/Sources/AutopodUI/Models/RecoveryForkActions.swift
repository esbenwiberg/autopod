import AutopodClient
import Foundation

public struct RecoveryForkActions: Sendable {
  public let scope: String
  public let draftScope: String
  public let available: Bool
  public let isFixture: Bool
  public let journalDirectory: URL?
  public let isCurrent: @MainActor @Sendable () -> Bool
  public let inspect: @MainActor @Sendable (String) async throws -> RecoveryForkInspection
  public let preview: @MainActor @Sendable (String, RecoveryForkInput) async throws -> RecoveryForkPreview
  public let create: @MainActor @Sendable (String, RecoveryForkRequest) async throws -> RecoveryForkOperation
  public let observe: @MainActor @Sendable (String, String) async throws -> RecoveryForkOperation
  public let openPod: @MainActor @Sendable (String) async throws -> Void
  public init(scope: String, draftScope: String? = nil, available: Bool = true, isFixture: Bool = false,
    journalDirectory: URL? = nil, isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    inspect: @escaping @MainActor @Sendable (String) async throws -> RecoveryForkInspection,
    preview: @escaping @MainActor @Sendable (String, RecoveryForkInput) async throws -> RecoveryForkPreview,
    create: @escaping @MainActor @Sendable (String, RecoveryForkRequest) async throws -> RecoveryForkOperation,
    observe: @escaping @MainActor @Sendable (String, String) async throws -> RecoveryForkOperation,
    openPod: @escaping @MainActor @Sendable (String) async throws -> Void = { _ in }) {
    self.scope = scope; self.draftScope = draftScope ?? scope; self.available = available
    self.isFixture = isFixture; self.journalDirectory = journalDirectory; self.isCurrent = isCurrent
    self.inspect = inspect; self.preview = preview; self.create = create; self.observe = observe; self.openPod = openPod
  }
  public static let unavailable = RecoveryForkActions(scope: "unavailable", available: false,
    inspect: { _ in throw URLError(.unsupportedURL) }, preview: { _, _ in throw URLError(.unsupportedURL) },
    create: { _, _ in throw URLError(.unsupportedURL) }, observe: { _, _ in throw URLError(.unsupportedURL) })
}
