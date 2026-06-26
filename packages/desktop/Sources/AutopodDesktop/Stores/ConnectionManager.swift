import Foundation
import AutopodClient

/// Manages daemon connection lifecycle — health polling, reconnect, state tracking.
@Observable
@MainActor
public final class ConnectionManager {

  // MARK: - Connection state

  public enum State: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case error(String)

    public var label: String {
      switch self {
      case .disconnected: "Disconnected"
      case .connecting: "Connecting…"
      case .connected: "Connected"
      case .error(let msg): "Error: \(msg)"
      }
    }
  }

  public private(set) var state: State = .disconnected
  public private(set) var connection: DaemonConnection?
  public private(set) var api: DaemonAPI?

  /// The token currently in use — read this instead of re-reading Keychain.
  public private(set) var activeToken: String?

  public var isConnected: Bool { state == .connected }

  public var connectionLabel: String {
    connection?.label ?? "No connection"
  }

  private var healthTask: Task<Void, Never>?
  private let entraAuthService = EntraDesktopAuthService()

  // MARK: - Init

  public init() {
    // Restore saved connection on launch
    let connections = ConnectionStore.loadAll()
    if let activeId = ConnectionStore.activeConnectionId(),
       let saved = connections.first(where: { $0.id == activeId }) {
      connection = saved
      if saved.authKind == .entra {
        state = .connecting
        Task { await restoreEntraConnection(saved) }
      } else {
        // For local connections, prefer the live dev token over stale Keychain value
        let token: String? = if saved.isLocal {
          DaemonConnection.readLocalDevToken()
            ?? KeychainHelper.load(for: saved.id)
            ?? ConnectionStore.loadToken(for: saved.id)
        } else {
          KeychainHelper.load(for: saved.id) ?? ConnectionStore.loadToken(for: saved.id)
        }

        if let token {
          let normalizedToken = Self.normalizeToken(token)
          guard !normalizedToken.isEmpty else { return }
          activeToken = normalizedToken
          api = makeAPI(baseURL: saved.url, token: normalizedToken, authKind: saved.authKind)
          // Persist refreshed token
          try? KeychainHelper.save(token: normalizedToken, for: saved.id)
          ConnectionStore.saveToken(normalizedToken, for: saved.id)
          // Kick off initial health check
          Task { await connectToActive() }
        }
      }
    }
  }

  // MARK: - Connect

  /// Save a new connection and connect to it.
  public func addAndConnect(
    name: String,
    url: URL,
    token: String,
    authKind: DaemonConnectionAuthKind = .manualToken
  ) async throws {
    let normalizedToken = Self.normalizeToken(token)
    let conn = DaemonConnection(name: name, url: url, authKind: authKind)

    // Save token to Keychain + UserDefaults fallback
    try? KeychainHelper.save(token: normalizedToken, for: conn.id)
    ConnectionStore.saveToken(normalizedToken, for: conn.id)

    // Save connection metadata
    var connections = ConnectionStore.loadAll()
    connections.append(conn)
    ConnectionStore.save(connections)
    ConnectionStore.setActiveConnectionId(conn.id)

    // Create API client and connect
    connection = conn
    activeToken = normalizedToken
    api = makeAPI(baseURL: url, token: normalizedToken, authKind: authKind)
    await connectToActive()
  }

  /// Test a connection without saving it.
  public func testConnection(
    url: URL,
    token: String,
    authKind: DaemonConnectionAuthKind = .manualToken
  ) async -> Result<Bool, DaemonError> {
    let normalizedToken = Self.normalizeToken(token)
    let testApi = makeAPI(baseURL: url, token: normalizedToken, authKind: authKind)
    do {
      _ = try await testApi.healthCheck()
      _ = try await testApi.getSessionStats()
      return .success(true)
    } catch let error as DaemonError {
      return .failure(error)
    } catch {
      return .failure(.networkError(error.localizedDescription))
    }
  }

  /// Switch to an existing saved connection after proving it is reachable.
  public func connect(to id: UUID) async throws {
    let connections = ConnectionStore.loadAll()
    guard let conn = connections.first(where: { $0.id == id }) else {
      throw DaemonError.notFound("connection")
    }

    let token: String? = if conn.authKind == .entra {
      try await entraAuthService.accessToken()
    } else if conn.isLocal {
      DaemonConnection.readLocalDevToken()
        ?? KeychainHelper.load(for: conn.id)
        ?? ConnectionStore.loadToken(for: conn.id)
    } else {
      KeychainHelper.load(for: conn.id) ?? ConnectionStore.loadToken(for: conn.id)
    }
    guard let token else {
      throw DaemonError.unauthorized("Missing saved token")
    }
    let normalizedToken = Self.normalizeToken(token)
    guard !normalizedToken.isEmpty else {
      throw DaemonError.unauthorized("Missing saved token")
    }

    let previousState = state
    let testApi = makeAPI(baseURL: conn.url, token: normalizedToken, authKind: conn.authKind)
    state = .connecting

    do {
      _ = try await testApi.healthCheck()
      _ = try await testApi.getSessionStats()
      healthTask?.cancel()
      healthTask = nil
      connection = conn
      activeToken = normalizedToken
      api = testApi
      ConnectionStore.setActiveConnectionId(conn.id)
      try? KeychainHelper.save(token: normalizedToken, for: conn.id)
      ConnectionStore.saveToken(normalizedToken, for: conn.id)
      state = .connected
      startHealthPolling()
    } catch {
      state = previousState
      throw error
    }
  }

  /// Disconnect and clear state.
  public func disconnect() {
    healthTask?.cancel()
    healthTask = nil
    state = .disconnected
    api = nil
  }

  /// Remove a saved connection.
  public func removeConnection(_ id: UUID) {
    KeychainHelper.delete(for: id)
    var connections = ConnectionStore.loadAll()
    connections.removeAll { $0.id == id }
    ConnectionStore.save(connections)

    if connection?.id == id {
      disconnect()
      connection = nil
      ConnectionStore.setActiveConnectionId(nil)
    }
  }

  // MARK: - Internal

  private static func normalizeToken(_ token: String) -> String {
    DaemonAPI.normalizeBearerToken(token)
  }

  public func signInWithMicrosoft() async throws -> String {
    let token = try await entraAuthService.signIn()
    activeToken = Self.normalizeToken(token)
    return activeToken ?? token
  }

  public func makeAccessTokenProvider() -> DaemonAccessTokenProvider {
    let authKind = connection?.authKind
    let manualToken = activeToken ?? ""
    let entraAuthService = entraAuthService
    return {
      if authKind == .entra {
        return try await entraAuthService.accessToken()
      }
      return manualToken
    }
  }

  private func connectToActive() async {
    guard let api else { return }
    state = .connecting

    do {
      _ = try await api.healthCheck()
      state = .connected
      startHealthPolling()
    } catch {
      state = .error(error.localizedDescription)
      startHealthPolling()  // Keep polling to detect daemon restart
    }
  }

  private func startHealthPolling() {
    healthTask?.cancel()
    healthTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        guard !Task.isCancelled else { break }
        await self?.pollHealth()
      }
    }
  }

  private func pollHealth() async {
    guard let api else { return }
    do {
      if let conn = connection, conn.authKind == .entra {
        try await refreshEntraTokenIfNeeded(for: conn)
      }
      _ = try await api.healthCheck()
      if state != .connected {
        state = .connected
      }
    } catch {
      // For local connections, try refreshing the dev token (daemon may have restarted)
      if let conn = connection, conn.isLocal, await refreshDevToken(for: conn) {
        return  // Refreshed — next poll will use the new token
      }
      if state == .connected {
        state = .error("Lost connection")
      }
    }
  }

  private func restoreEntraConnection(_ saved: DaemonConnection) async {
    do {
      let token = Self.normalizeToken(try await entraAuthService.accessToken())
      guard !token.isEmpty else {
        state = .error("Microsoft sign-in returned an empty token")
        return
      }
      activeToken = token
      api = makeAPI(baseURL: saved.url, token: token, authKind: .entra)
      try? KeychainHelper.save(token: token, for: saved.id)
      ConnectionStore.saveToken(token, for: saved.id)
      await connectToActive()
    } catch {
      state = .error(error.localizedDescription)
    }
  }

  private func refreshEntraTokenIfNeeded(for conn: DaemonConnection) async throws {
    let freshToken = Self.normalizeToken(try await entraAuthService.accessToken())
    guard !freshToken.isEmpty else {
      throw DaemonError.unauthorized("Microsoft sign-in returned an empty token")
    }
    if freshToken != activeToken {
      activeToken = freshToken
      try? KeychainHelper.save(token: freshToken, for: conn.id)
      ConnectionStore.saveToken(freshToken, for: conn.id)
    }
  }

  private func makeAPI(
    baseURL: URL,
    token: String,
    authKind: DaemonConnectionAuthKind
  ) -> DaemonAPI {
    if authKind == .entra {
      return DaemonAPI(
        baseURL: baseURL,
        initialToken: token,
        tokenProvider: { [entraAuthService] in
          try await entraAuthService.accessToken()
        }
      )
    }
    return DaemonAPI(baseURL: baseURL, token: token)
  }

  /// Try to read a fresh dev token from disk. Returns true if token was updated.
  private func refreshDevToken(for conn: DaemonConnection) async -> Bool {
    guard let freshToken = DaemonConnection.readLocalDevToken(),
          freshToken != activeToken else { return false }

    // Token changed — rebuild the API client
    activeToken = freshToken
    api = makeAPI(baseURL: conn.url, token: freshToken, authKind: conn.authKind)
    try? KeychainHelper.save(token: freshToken, for: conn.id)
    ConnectionStore.saveToken(freshToken, for: conn.id)

    // Test the new token
    do {
      _ = try await api!.healthCheck()
      state = .connected
      return true
    } catch {
      return false
    }
  }
}
