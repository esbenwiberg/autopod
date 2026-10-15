import Foundation
import AutopodClient

/// The connected API instance, separate from the stable source used by cached pods.
public struct DesktopConnectionIdentity: Equatable {
  private let connectionID: UUID
  private let apiID: ObjectIdentifier

  public init?(isConnected: Bool, connectionID: UUID?, api: DaemonAPI?) {
    guard isConnected, let connectionID, let api else { return nil }
    self.connectionID = connectionID
    self.apiID = ObjectIdentifier(api)
  }
}

/// Shared by both entrypoints: ordinary appearance/observation is idempotent;
/// explicit recovery and reconnection deliberately create a fresh ownership epoch.
public struct DesktopConnectionWiringGate {
  private var wired: DesktopConnectionIdentity?
  public init() {}

  public mutating func admit(_ identity: DesktopConnectionIdentity, force: Bool = false) -> Bool {
    guard force || wired != identity else { return false }
    wired = identity
    return true
  }

  public mutating func disconnect() { wired = nil }
}

@MainActor
func recoverDesktopConnection(
  recover: @MainActor () async -> Bool,
  onRecovered: @MainActor () -> Void
) async -> Bool {
  guard await recover() else { return false }
  onRecovered()
  return true
}
