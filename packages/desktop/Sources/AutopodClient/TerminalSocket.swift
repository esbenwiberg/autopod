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

    setState(.connected)

    receiveTask = Task { [weak self] in
      await self?.receiveLoop(ws)
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

  private func receiveLoop(_ ws: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await ws.receive()
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
        if !Task.isCancelled {
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
        // Give the connection a moment to fail if the server rejects it
        try? await Task.sleep(nanoseconds: 500_000_000)
        let currentState = await self.state
        if case .connected = currentState { return }
      }
      await self.setState(.error("Connection lost — could not reconnect"))
    }
  }

  private func setState(_ newState: State) {
    state = newState
    onStateChange(newState)
  }
}
