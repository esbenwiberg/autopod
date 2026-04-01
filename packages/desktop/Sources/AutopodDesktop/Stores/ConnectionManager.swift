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
       let saved = connections.first(where: { $0.id == activeId }),
       let token = KeychainHelper.load(for: saved.id) ?? ConnectionStore.loadToken(for: saved.id) {
      connection = saved
      api = DaemonAPI(baseURL: saved.url, token: token)
      // Kick off initial health check
      Task { await connectToActive() }
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
      if state == .connected {
        state = .error("Lost connection")
      }
    }
  }
}
