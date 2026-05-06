import SwiftUI

// MARK: - Daemon auth token environment key

/// Injects the daemon bearer token into the SwiftUI environment so authenticated
/// image views can fetch screenshots without prop-drilling the token everywhere.
/// Set once at the app root from `ConnectionManager.activeToken`.
private struct DaemonAuthTokenKey: EnvironmentKey {
  static let defaultValue: String = ""
}

public extension EnvironmentValues {
  var daemonAuthToken: String {
    get { self[DaemonAuthTokenKey.self] }
    set { self[DaemonAuthTokenKey.self] = newValue }
  }
}
