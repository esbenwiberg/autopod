import Foundation

/// WebSocket client for the daemon `/events` endpoint.
/// Handles subscribe, replay, reconnect with exponential backoff.
public actor EventSocket {

  // MARK: - State

  public enum State: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
  }

  private var state: State = .disconnected
  private var webSocketTask: URLSessionWebSocketTask?
  private var lastEventId: Int = 0
  private var reconnectAttempt = 0
  private var receiveTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var lastPingAt: Date = .distantPast

  private let baseURL: URL
  private let token: String
  private let pod: URLSession
  private let onEvent: @Sendable (RawSystemEvent) -> Void
  private let onStateChange: @Sendable (State) -> Void

  private static let maxBackoff: TimeInterval = 16
  private static let heartbeatTimeout: TimeInterval = 45  // 30s ping + 15s grace

  // MARK: - Init

  public init(
    baseURL: URL,
    token: String,
    onEvent: @escaping @Sendable (RawSystemEvent) -> Void,
    onStateChange: @escaping @Sendable (State) -> Void
  ) {
    self.baseURL = baseURL
    self.token = token
    self.pod = URLSession.shared
    self.onEvent = onEvent
    self.onStateChange = onStateChange
  }

  // MARK: - Public API

  public func connect() {
    guard state == .disconnected || state != .connecting else { return }
    setState(.connecting)
    doConnect()
  }

  public func disconnect() {
    receiveTask?.cancel()
    receiveTask = nil
    heartbeatTask?.cancel()
    heartbeatTask = nil
    webSocketTask?.cancel(with: .normalClosure, reason: nil)
    webSocketTask = nil
    reconnectAttempt = 0
    setState(.disconnected)
  }

  public func subscribeAll() {
    send(["type": "subscribe_all"])
  }

  public func subscribe(podId: String) {
    send(["type": "subscribe", "podId": podId])
  }

  public func unsubscribe(podId: String) {
    send(["type": "unsubscribe", "podId": podId])
  }

  // MARK: - Internal

  private func doConnect() {
    // Build WebSocket URL: ws(s)://host:port/events?token=xxx
    var components = URLComponents(url: baseURL.appendingPathComponent("events"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "token", value: token)]
    // Switch scheme to ws/wss
    if components.scheme == "http" { components.scheme = "ws" }
    else if components.scheme == "https" { components.scheme = "wss" }

    guard let url = components.url else {
      setState(.disconnected)
      return
    }

    let ws = pod.webSocketTask(with: url)
    webSocketTask = ws
    ws.resume()

    // Start receiving
    receiveTask = Task { [weak self] in
      await self?.receiveLoop(ws)
    }

    // Connected — subscribe and replay
    setState(.connected)
    reconnectAttempt = 0
    lastPingAt = Date()
    subscribeAll()

    // Replay missed events if we have a last known ID
    if lastEventId > 0 {
      send(["type": "replay", "lastEventId": lastEventId])
    }

    // Start heartbeat monitor
    startHeartbeatMonitor()
  }

  private func receiveLoop(_ ws: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await ws.receive()
        lastPingAt = Date()

        switch message {
        case .string(let text):
          guard let data = text.data(using: .utf8) else { continue }
          do {
            let event = try JSONDecoder().decode(RawSystemEvent.self, from: data)
            // Track event ID for replay
            if let eventId = event._eventId, eventId > lastEventId {
              lastEventId = eventId
            }
            onEvent(event)
          } catch {
            // Skip unparseable events (e.g. ack messages like "subscribed_all")
          }

        case .data:
          break  // Binary frames not expected

        @unknown default:
          break
        }
      } catch {
        // Connection lost — trigger reconnect
        if !Task.isCancelled {
            scheduleReconnect()
        }
        return
      }
    }
  }

  private func startHeartbeatMonitor() {
    heartbeatTask?.cancel()
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(15))
        guard !Task.isCancelled else { return }
        guard let self else { return }
        let elapsed = await Date().timeIntervalSince(self.lastPingAt)
        if elapsed > Self.heartbeatTimeout {
          await self.scheduleReconnect()
          return
        }
      }
    }
  }

  private func scheduleReconnect() {
    // Clean up current connection
    receiveTask?.cancel()
    heartbeatTask?.cancel()
    webSocketTask?.cancel(with: .goingAway, reason: nil)
    webSocketTask = nil

    reconnectAttempt += 1
    setState(.reconnecting(attempt: reconnectAttempt))

    // Exponential backoff: 1, 2, 4, 8, 16, 16, 16...
    let delay = min(pow(2.0, Double(reconnectAttempt - 1)), Self.maxBackoff)

    Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      await self?.doConnect()
    }
  }

  private func send(_ dict: [String: any Sendable]) {
    guard let ws = webSocketTask else { return }
    // Build JSON manually to avoid Encodable complexity with heterogeneous dict
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let text = String(data: data, encoding: .utf8) {
      ws.send(.string(text)) { _ in }
    }
  }

  private func setState(_ newState: State) {
    state = newState
    onStateChange(newState)
  }
}
