import SwiftUI

// MARK: - Daemon auth token environment key

/// Injects the daemon bearer token into the SwiftUI environment so authenticated
/// image views can fetch screenshots without prop-drilling the token everywhere.
/// Set once at the app root from `ConnectionManager.activeToken`.
private struct DaemonAuthTokenKey: EnvironmentKey {
  static let defaultValue: String = ""
}

// MARK: - Daemon base URL environment key

/// The daemon base URL, injected alongside the auth token.
/// Used by `AuthenticatedImageLoader` to validate that screenshot URLs resolve
/// to the same host as the daemon before attaching the Bearer token.
private struct DaemonBaseURLKey: EnvironmentKey {
  static let defaultValue: URL? = nil
}

public extension EnvironmentValues {
  var daemonAuthToken: String {
    get { self[DaemonAuthTokenKey.self] }
    set { self[DaemonAuthTokenKey.self] = newValue }
  }

  var daemonBaseURL: URL? {
    get { self[DaemonBaseURLKey.self] }
    set { self[DaemonBaseURLKey.self] = newValue }
  }
}
