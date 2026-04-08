import Foundation

/// WebSocket adapter for interactive terminal I/O.
/// Connects to WS /sessions/:id/terminal on the daemon.
/// Binary frames for stdin/stdout, JSON control frames for resize.
/// Auto-reconnects on unexpected disconnects with exponential backoff.
public actor TerminalSocket {

  public enum State: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case error(String)
  }

  private var webSocketTask: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var state: State = .disconnected
  /// Monotonic counter incremented on every `doConnect()`. Stale receive loops
  /// compare their captured generation to the current value — if they differ,
  /// a newer connection has superseded them and they must not trigger reconnect.
  private var connectionGeneration: UInt64 = 0

  /// Tracks the last connect params so we can auto-reconnect.
  private var lastSessionId: String?
  private var lastCols: Int = 80
  private var lastRows: Int = 24

  private static let maxReconnectAttempts = 5
  private static let baseDelay: UInt64 = 1_000_000_000 // 1 second

  private let baseURL: URL
  private let token: String
  private let session: URLSession
  private let onData: @Sendable (Data) -> Void
  private let onStateChange: @Sendable (State) -> Void

  public init(
    baseURL: URL,
    token: String,
    onData: @escaping @Sendable (Data) -> Void,
    onStateChange: @escaping @Sendable (State) -> Void
  ) {
    self.baseURL = baseURL
    self.token = token
    self.session = URLSession.shared
    self.onData = onData
    self.onStateChange = onStateChange
  }

  // MARK: - Connect

  public func connect(sessionId: String, cols: Int, rows: Int) {
    cancelAll()
    lastSessionId = sessionId
    lastCols = cols
    lastRows = rows
    doConnect(sessionId: sessionId, cols: cols, rows: rows)
  }

  private func doConnect(sessionId: String, cols: Int, rows: Int) {
    // Kill previous connection before opening a new one. Critical during
    // reconnect: scheduleReconnect() calls doConnect() without cancelAll(),
    // so without this cleanup the old WebSocket and receive loop stay alive,
    // eventually cascading into multiple parallel connections to tmux.
    receiveTask?.cancel()
    receiveTask = nil
    webSocketTask?.cancel(with: .goingAway, reason: nil)
    webSocketTask = nil

    connectionGeneration &+= 1
    let gen = connectionGeneration

    setState(.connecting)

    var components = URLComponents(
      url: baseURL.appendingPathComponent("sessions/\(sessionId)/terminal"),
      resolvingAgainstBaseURL: false
    )!
    components.queryItems = [
      URLQueryItem(name: "token", value: token),
      URLQueryItem(name: "cols", value: "\(cols)"),
      URLQueryItem(name: "rows", value: "\(rows)"),
    ]
    if components.scheme == "http" { components.scheme = "ws" }
    else if components.scheme == "https" { components.scheme = "wss" }

    guard let url = components.url else {
      setState(.error("Invalid URL"))
      return
    }

    let ws = session.webSocketTask(with: url)
    webSocketTask = ws
    ws.resume()

    // Don't set .connected here — wait for the first successful receive in
    // receiveLoop so we know the connection is actually alive.
    receiveTask = Task { [weak self] in
      await self?.receiveLoop(ws, generation: gen)
    }
  }

  // MARK: - Disconnect

  public func disconnect() {
    cancelAll()
    lastSessionId = nil
    setState(.disconnected)
  }

  private func cancelAll() {
    reconnectTask?.cancel()
    reconnectTask = nil
    receiveTask?.cancel()
    receiveTask = nil
    webSocketTask?.cancel(with: .normalClosure, reason: nil)
    webSocketTask = nil
  }

  // MARK: - Send stdin

  public func send(data: Data) {
    guard let ws = webSocketTask else { return }
    ws.send(.data(data)) { _ in }
  }

  public func send(text: String) {
    guard let ws = webSocketTask else { return }
    ws.send(.string(text)) { _ in }
  }

  // MARK: - Resize

  public func resize(cols: Int, rows: Int) {
    lastCols = cols
    lastRows = rows
    guard let ws = webSocketTask else { return }
    let json = """
    {"type":"resize","cols":\(cols),"rows":\(rows)}
    """
    ws.send(.string(json)) { _ in }
  }

  // MARK: - Internal

  private func receiveLoop(_ ws: URLSessionWebSocketTask, generation: UInt64) async {
    var didConnect = false
    while !Task.isCancelled {
      do {
        let message = try await ws.receive()
        if !didConnect {
          didConnect = true
          setState(.connected)
        }
        switch message {
        case .data(let data):
          onData(data)
        case .string(let text):
          if let data = text.data(using: .utf8) {
            onData(data)
          }
        @unknown default:
          break
        }
      } catch {
        // Only trigger reconnect if this is still the active connection.
        // A stale loop (superseded by a newer doConnect) must exit silently.
        if !Task.isCancelled && generation == connectionGeneration {
          scheduleReconnect()
        }
        return
      }
    }
  }

  private func scheduleReconnect() {
    guard let sessionId = lastSessionId else {
      setState(.error("Connection lost"))
      return
    }

    reconnectTask = Task { [weak self] in
      guard let self else { return }
      for attempt in 1...Self.maxReconnectAttempts {
        guard !Task.isCancelled else { return }
        await self.setState(.reconnecting(attempt: attempt))
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        let delay = Self.baseDelay * UInt64(1 << (attempt - 1))
        try? await Task.sleep(nanoseconds: delay)
        guard !Task.isCancelled else { return }
        let cols = await self.lastCols
        let rows = await self.lastRows
        await self.doConnect(sessionId: sessionId, cols: cols, rows: rows)
        // Wait up to 3s for the connection to prove itself alive (first
        // successful receive flips state to .connected).
        for _ in 0..<6 {
          try? await Task.sleep(nanoseconds: 500_000_000)
          guard !Task.isCancelled else { return }
          let currentState = await self.state
          if case .connected = currentState { return }
          if case .error = currentState { break }
        }
      }
      await self.setState(.error("Connection lost — could not reconnect"))
    }
  }

  private func setState(_ newState: State) {
    state = newState
    onStateChange(newState)
  }
}
