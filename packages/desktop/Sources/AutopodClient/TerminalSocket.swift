import Foundation

/// WebSocket adapter for interactive terminal I/O.
/// Connects to WS /sessions/:id/terminal on the daemon.
/// Binary frames for stdin/stdout, JSON control frames for resize.
public actor TerminalSocket {

  public enum State: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case error(String)
  }

  private var webSocketTask: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var state: State = .disconnected

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
    disconnect()
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
    receiveTask?.cancel()
    receiveTask = nil
    webSocketTask?.cancel(with: .normalClosure, reason: nil)
    webSocketTask = nil
    setState(.disconnected)
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
          setState(.error("Connection lost"))
        }
        return
      }
    }
  }

  private func setState(_ newState: State) {
    state = newState
    onStateChange(newState)
  }
}
