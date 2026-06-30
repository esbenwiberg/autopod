import Foundation
import AutopodClient

/// Manages daemon connection lifecycle — health polling, reconnect, state tracking.
@Observable
@MainActor
public final class ConnectionManager {
  private static let pendingDeepLinkKey = "autopod.pendingDeepLink"

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
  private var authenticationRecoveryTask: Task<Bool, Never>?
  private var cliLoginTask: Task<String, Error>?
  private let entraAuthService = EntraDesktopAuthService()

  public private(set) var isRecoveringAuthentication = false
  public private(set) var authenticationRecoveryError: String?

  // MARK: - Init

  public init() {
    // CLI launches should win over stale saved state. Restoring the previous
    // connection first can touch old Keychain items and block launch behind a
    // system prompt before the fresh `ap desktop` deep link is handled.
    if consumeLaunchDeepLink() { return }
    restoreSavedConnection()
  }

  private func restoreSavedConnection() {
    let connections = ConnectionStore.loadAll()
    if let activeId = ConnectionStore.activeConnectionId(),
       let saved = connections.first(where: { $0.id == activeId }) {
      connection = saved
      if saved.authKind == .entra {
        if let token = Self.launchEntraToken(for: saved) {
          Task { try? await connect(saved, using: token, persistToKeychain: false) }
        } else {
          state = .error("Microsoft sign-in required. Run ap login or sign in from Autopod.")
        }
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

    // Save token to Keychain + UserDefaults fallback. Entra connections can be
    // created before a token is available, so do not persist an empty secret.
    if !normalizedToken.isEmpty {
      try? KeychainHelper.save(token: normalizedToken, for: conn.id)
      ConnectionStore.saveToken(normalizedToken, for: conn.id)
    }

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
      if let launchToken = Self.launchEntraToken(for: conn) {
        launchToken
      } else if let activeToken {
        activeToken
      } else {
        try await entraAuthService.accessToken()
      }
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

  // MARK: - Deep links

  /// Consume a CLI-provided launch request before SwiftUI view lifecycle begins.
  @discardableResult
  private func consumeLaunchDeepLink() -> Bool {
    guard let deepLink = Self.launchDeepLink() else { return false }
    UserDefaults.standard.removeObject(forKey: Self.pendingDeepLinkKey)
    UserDefaults.standard.synchronize()
    handleDeepLink(deepLink)
    return true
  }

  private static func launchDeepLink() -> URL? {
    if let arg = CommandLine.arguments.dropFirst().first(where: { $0.hasPrefix("autopod://") }),
       let url = URL(string: arg) {
      return url
    }

    guard let raw = UserDefaults.standard.string(forKey: pendingDeepLinkKey) else { return nil }
    return URL(string: raw)
  }

  /// Handle an `autopod://connect?url=…&name=…&token=…&authKind=…` deep link.
  ///
  /// Used by `ap desktop` to point the app at a daemon at launch. Upserts by URL:
  /// an already-saved connection is switched to and reconnected (no clobber); a new
  /// one is added. Token resolution: explicit `token` param wins; otherwise local
  /// connections fall back to the on-disk dev token, and Entra connections sign in.
  public func handleDeepLink(_ deepLink: URL) {
    guard deepLink.scheme == "autopod", deepLink.host == "connect",
      let comps = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
      let rawURL = comps.queryItems?.first(where: { $0.name == "url" })?.value,
      let url = DaemonConnection.normalizedURL(from: rawURL)
    else { return }

    let name = comps.queryItems?.first(where: { $0.name == "name" })?.value ?? (url.host ?? "daemon")
    let kind =
      DaemonConnectionAuthKind(
        rawValue: comps.queryItems?.first(where: { $0.name == "authKind" })?.value ?? "")
      ?? .manualToken
    let tokenParam = comps.queryItems?.first(where: { $0.name == "token" })?.value

    Task { @MainActor in
      // Already saved? switch + reconnect rather than appending a duplicate.
      if let existing = ConnectionStore.loadAll().first(where: { $0.url == url }) {
        let updated = upsertConnection(existing, name: name, authKind: kind)
        ConnectionStore.setActiveConnectionId(updated.id)
        if kind == .entra {
          await connectToLaunchEntraConnection(updated)
        } else {
          try? await connect(to: updated.id)
        }
        return
      }

      if kind == .entra {
        let conn = saveNewConnection(name: name, url: url, authKind: .entra)
        await connectToLaunchEntraConnection(conn, tokenOverride: tokenParam)
        return
      }

      let isLocal = url.host == "localhost" || url.host == "127.0.0.1" || url.host == "::1"
      let token = tokenParam ?? (isLocal ? DaemonConnection.readLocalDevToken() : nil)
      if let token {
        try? await addAndConnect(name: name, url: url, token: token, authKind: .manualToken)
      }
    }
  }

  private func connectToLaunchEntraConnection(
    _ conn: DaemonConnection,
    tokenOverride: String? = nil
  ) async {
    ConnectionStore.setActiveConnectionId(conn.id)
    connection = conn
    guard let token = Self.normalizeOptionalToken(tokenOverride ?? Self.launchEntraToken(for: conn)),
          !token.isEmpty else {
      state = .connecting
      let recovered = await recoverAuthentication()
      if !recovered {
        state = .error(authenticationRecoveryError ?? "Microsoft sign-in required. Run ap login.")
      }
      return
    }
    try? await connect(conn, using: token, persistToKeychain: false)
  }

  private func saveNewConnection(
    name: String,
    url: URL,
    authKind: DaemonConnectionAuthKind
  ) -> DaemonConnection {
    let conn = DaemonConnection(name: name, url: url, authKind: authKind)
    var connections = ConnectionStore.loadAll()
    connections.append(conn)
    ConnectionStore.save(connections)
    ConnectionStore.setActiveConnectionId(conn.id)
    return conn
  }

  private func upsertConnection(
    _ existing: DaemonConnection,
    name: String,
    authKind: DaemonConnectionAuthKind
  ) -> DaemonConnection {
    var updated = existing
    var changed = false
    if updated.name != name {
      updated.name = name
      changed = true
    }
    if updated.authKind != authKind {
      updated.authKind = authKind
      changed = true
    }
    guard changed else { return existing }

    var connections = ConnectionStore.loadAll()
    if let index = connections.firstIndex(where: { $0.id == existing.id }) {
      connections[index] = updated
      ConnectionStore.save(connections)
    }
    return updated
  }

  // MARK: - Internal

  nonisolated private static func normalizeToken(_ token: String) -> String {
    DaemonAPI.normalizeBearerToken(token)
  }

  nonisolated private static func normalizeOptionalToken(_ token: String?) -> String? {
    guard let token else { return nil }
    let normalized = normalizeToken(token)
    return normalized.isEmpty ? nil : normalized
  }

  nonisolated private static func launchEntraToken(for conn: DaemonConnection) -> String? {
    cliEntraAccessToken() ?? normalizeOptionalToken(ConnectionStore.loadToken(for: conn.id))
  }

  nonisolated static func cliEntraAccessToken(
    credentialsURL: URL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/credentials.json"),
    now: Date = Date()
  ) -> String? {
    guard let data = try? Data(contentsOf: credentialsURL) else { return nil }
    return cliEntraAccessToken(from: data, now: now)
  }

  nonisolated static func cliEntraAccessToken(from data: Data, now: Date = Date()) -> String? {
    struct CliCredentials: Decodable {
      let accessToken: String
      let expiresAt: String
    }

    guard let credentials = try? JSONDecoder().decode(CliCredentials.self, from: data),
          let expiresAt = parseCliDate(credentials.expiresAt),
          expiresAt.timeIntervalSince(now) > 300 else {
      return nil
    }
    return normalizeToken(credentials.accessToken)
  }

  nonisolated private static func parseCliDate(_ raw: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: raw) { return date }

    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    return wholeSeconds.date(from: raw)
  }

  public func signInWithMicrosoft() async throws -> String {
    let token = try await entraAuthService.signIn()
    let normalized = Self.normalizeToken(token)
    if let conn = connection {
      applyActiveToken(normalized, for: conn, persistToKeychain: true)
    } else {
      activeToken = normalized
    }
    return activeToken ?? normalized
  }

  public func makeAccessTokenProvider() -> DaemonAccessTokenProvider {
    let fallbackToken = activeToken ?? ""
    let entraAuthService = entraAuthService
    return { [weak self] in
      guard let self else {
        if let cliToken = Self.cliEntraAccessToken() { return cliToken }
        return try await entraAuthService.accessToken()
      }
      return try await self.accessTokenForCurrentConnection(fallbackToken: fallbackToken)
    }
  }

  /// Repair an expired/revoked daemon auth token. For hosted Entra connections this
  /// runs `ap login` in the background, rereads the CLI credentials, and reconnects.
  @discardableResult
  public func recoverAuthentication() async -> Bool {
    if let task = authenticationRecoveryTask {
      return await task.value
    }

    let task = Task { @MainActor [weak self] in
      guard let self else { return false }
      self.isRecoveringAuthentication = true
      self.authenticationRecoveryError = nil
      defer {
        self.isRecoveringAuthentication = false
        self.authenticationRecoveryTask = nil
      }

      do {
        try await self.performAuthenticationRecovery()
        return true
      } catch {
        self.authenticationRecoveryError = error.localizedDescription
        return false
      }
    }
    authenticationRecoveryTask = task
    return await task.value
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
        refreshCliEntraTokenIfAvailable(for: conn)
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
    connection = saved
    state = .connecting
    do {
      let token = try await refreshEntraAccessToken(forceLogin: false, fallbackToken: nil)
      guard !token.isEmpty else {
        state = .error("Microsoft sign-in returned an empty token")
        return
      }
      applyActiveToken(token, for: saved, persistToKeychain: true)
      await connectToActive()
    } catch {
      state = .error(error.localizedDescription)
    }
  }

  private func refreshEntraTokenIfNeeded(for conn: DaemonConnection) async throws {
    let freshToken = try await refreshEntraAccessToken(forceLogin: false, fallbackToken: activeToken)
    guard !freshToken.isEmpty else {
      throw DaemonError.unauthorized("Microsoft sign-in returned an empty token")
    }
    if freshToken != activeToken {
      applyActiveToken(freshToken, for: conn, persistToKeychain: true)
    }
  }

  private func refreshCliEntraTokenIfAvailable(for conn: DaemonConnection) {
    guard let freshToken = Self.launchEntraToken(for: conn),
          freshToken != activeToken else { return }
    applyActiveToken(freshToken, for: conn, persistToKeychain: false)
  }

  private func connect(
    _ conn: DaemonConnection,
    using token: String,
    persistToKeychain: Bool
  ) async throws {
    let normalizedToken = Self.normalizeToken(token)
    guard !normalizedToken.isEmpty else {
      throw DaemonError.unauthorized("Missing saved token")
    }

    let testApi = makeAPI(baseURL: conn.url, token: normalizedToken, authKind: conn.authKind)
    state = .connecting

    do {
      _ = try await testApi.healthCheck()
      _ = try await testApi.getSessionStats()
      healthTask?.cancel()
      healthTask = nil
      connection = conn
      api = testApi
      ConnectionStore.setActiveConnectionId(conn.id)
      applyActiveToken(normalizedToken, for: conn, persistToKeychain: persistToKeychain)
      state = .connected
      startHealthPolling()
    } catch {
      connection = conn
      api = testApi
      applyActiveToken(normalizedToken, for: conn, persistToKeychain: persistToKeychain)
      state = .error(error.localizedDescription)
      throw error
    }
  }

  private func makeAPI(
    baseURL: URL,
    token: String,
    authKind: DaemonConnectionAuthKind
  ) -> DaemonAPI {
    if authKind == .entra {
      let fallbackToken = Self.normalizeToken(token)
      return DaemonAPI(
        baseURL: baseURL,
        initialToken: fallbackToken,
        tokenProvider: { [weak self] in
          guard let self else {
            return Self.cliEntraAccessToken() ?? fallbackToken
          }
          return try await self.refreshEntraAccessToken(
            forceLogin: false,
            fallbackToken: fallbackToken
          )
        }
      )
    }
    return DaemonAPI(baseURL: baseURL, token: token)
  }

  private func accessTokenForCurrentConnection(fallbackToken: String) async throws -> String {
    guard let conn = connection else { return fallbackToken }
    if conn.authKind == .entra {
      return try await refreshEntraAccessToken(forceLogin: false, fallbackToken: fallbackToken)
    }
    if conn.isLocal, let freshToken = DaemonConnection.readLocalDevToken(),
       freshToken != activeToken {
      applyActiveToken(freshToken, for: conn, persistToKeychain: true)
      return freshToken
    }
    return activeToken ?? fallbackToken
  }

  private func performAuthenticationRecovery() async throws {
    guard let conn = connection else {
      throw DaemonError.networkError("No daemon connection is active")
    }

    if conn.isLocal {
      if await refreshDevToken(for: conn) { return }
      throw DaemonError.unauthorized("Local daemon token is invalid or missing")
    }

    guard conn.authKind == .entra else {
      throw DaemonError.unauthorized("Saved token is invalid. Update the connection token.")
    }

    let token = try await refreshEntraAccessToken(forceLogin: true, fallbackToken: nil)
    try await connect(conn, using: token, persistToKeychain: false)
  }

  private func refreshEntraAccessToken(
    forceLogin: Bool,
    fallbackToken: String?
  ) async throws -> String {
    let applyConnection = connection?.authKind == .entra ? connection : nil
    if !forceLogin, let cliToken = Self.cliEntraAccessToken() {
      applyActiveToken(cliToken, for: applyConnection, persistToKeychain: false)
      return cliToken
    }

    if !forceLogin, let token = try? await entraAuthService.accessToken() {
      let normalized = Self.normalizeToken(token)
      applyActiveToken(normalized, for: applyConnection, persistToKeychain: true)
      return normalized
    }

    do {
      let cliToken = try await runCliLoginAndReadToken()
      applyActiveToken(cliToken, for: applyConnection, persistToKeychain: false)
      return cliToken
    } catch {
      if !forceLogin, let fallbackToken = Self.normalizeOptionalToken(fallbackToken) {
        return fallbackToken
      }
      let token = try await entraAuthService.signIn()
      let normalized = Self.normalizeToken(token)
      applyActiveToken(normalized, for: applyConnection, persistToKeychain: true)
      return normalized
    }
  }

  private func runCliLoginAndReadToken() async throws -> String {
    if let task = cliLoginTask {
      return try await task.value
    }

    let task = Task {
      try await Self.runApLoginAndReadToken()
    }
    cliLoginTask = task
    defer { cliLoginTask = nil }
    return try await task.value
  }

  private func applyActiveToken(
    _ token: String,
    for conn: DaemonConnection?,
    persistToKeychain: Bool
  ) {
    let normalized = Self.normalizeToken(token)
    guard !normalized.isEmpty else { return }
    activeToken = normalized

    guard let conn else { return }
    if api == nil || api?.baseURL != conn.url {
      api = makeAPI(baseURL: conn.url, token: normalized, authKind: conn.authKind)
    }
    if persistToKeychain {
      try? KeychainHelper.save(token: normalized, for: conn.id)
    }
    ConnectionStore.saveToken(normalized, for: conn.id)
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

  nonisolated private static func runApLoginAndReadToken() async throws -> String {
    let apURL = try findExecutable("ap")
    try await runApLogin(apURL)
    guard let token = cliEntraAccessToken() else {
      throw DaemonError.unauthorized("ap login finished but did not write a valid access token")
    }
    return token
  }

  nonisolated private static func findExecutable(_ name: String) throws -> URL {
    if let path = resolveViaLoginShell(name) {
      return URL(fileURLWithPath: path)
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      "/opt/homebrew/bin/\(name)",
      "/usr/local/bin/\(name)",
      "\(home)/.local/bin/\(name)",
      "\(home)/.npm/bin/\(name)",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
      return URL(fileURLWithPath: path)
    }

    throw DaemonError.networkError("\(name) CLI not found. Install it or add it to your login shell PATH.")
  }

  nonisolated private static func resolveViaLoginShell(_ name: String) -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: shell)
    proc.arguments = ["-l", "-c", "command -v \(name)"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()

    guard proc.terminationStatus == 0 else { return nil }
    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (output?.isEmpty == false) ? output : nil
  }

  nonisolated private static func runApLogin(_ apURL: URL) async throws {
    try await Task.detached(priority: .userInitiated) {
      let proc = Process()
      proc.executableURL = apURL
      proc.arguments = ["login"]

      let output = Pipe()
      let error = Pipe()
      proc.standardOutput = output
      proc.standardError = error

      try proc.run()
      proc.waitUntilExit()

      guard proc.terminationStatus == 0 else {
        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let message = [stderr, stdout]
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
          .first(where: { !$0.isEmpty })
          ?? "ap login exited with code \(proc.terminationStatus)"
        throw DaemonError.unauthorized(message)
      }
    }.value
  }
}
