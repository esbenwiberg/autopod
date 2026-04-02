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

  // MARK: - Init

  public init() {
    // Restore saved connection on launch
    let connections = ConnectionStore.loadAll()
    if let activeId = ConnectionStore.activeConnectionId(),
       let saved = connections.first(where: { $0.id == activeId }) {
      // For local connections, prefer the live dev token over stale Keychain value
      let token: String? = if saved.isLocal {
        DaemonConnection.readLocalDevToken()
          ?? KeychainHelper.load(for: saved.id)
          ?? ConnectionStore.loadToken(for: saved.id)
      } else {
        KeychainHelper.load(for: saved.id) ?? ConnectionStore.loadToken(for: saved.id)
      }

      if let token {
        connection = saved
        activeToken = token
        api = DaemonAPI(baseURL: saved.url, token: token)
        // Persist refreshed token
        try? KeychainHelper.save(token: token, for: saved.id)
        ConnectionStore.saveToken(token, for: saved.id)
        // Kick off initial health check
        Task { await connectToActive() }
      }
    }
  }

  // MARK: - Connect

  /// Save a new connection and connect to it.
  public func addAndConnect(name: String, url: URL, token: String) async throws {
    let conn = DaemonConnection(name: name, url: url)

    // Save token to Keychain + UserDefaults fallback
    try? KeychainHelper.save(token: token, for: conn.id)
    ConnectionStore.saveToken(token, for: conn.id)

    // Save connection metadata
    var connections = ConnectionStore.loadAll()
    connections.append(conn)
    ConnectionStore.save(connections)
    ConnectionStore.setActiveConnectionId(conn.id)

    // Create API client and connect
    connection = conn
    activeToken = token
    api = DaemonAPI(baseURL: url, token: token)
    await connectToActive()
  }

  /// Test a connection without saving it.
  public func testConnection(url: URL, token: String) async -> Result<Bool, DaemonError> {
    let testApi = DaemonAPI(baseURL: url, token: token)
    do {
      _ = try await testApi.healthCheck()
      return .success(true)
    } catch let error as DaemonError {
      return .failure(error)
    } catch {
      return .failure(.networkError(error.localizedDescription))
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

  /// Try to read a fresh dev token from disk. Returns true if token was updated.
  private func refreshDevToken(for conn: DaemonConnection) async -> Bool {
    guard let freshToken = DaemonConnection.readLocalDevToken(),
          freshToken != activeToken else { return false }

    // Token changed — rebuild the API client
    activeToken = freshToken
    api = DaemonAPI(baseURL: conn.url, token: freshToken)
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
