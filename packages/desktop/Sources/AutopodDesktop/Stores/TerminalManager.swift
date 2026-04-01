import Foundation
import AutopodClient

/// Manages terminal WebSocket connections for session detail views.
@Observable
@MainActor
public final class TerminalManager {

  public private(set) var output = ""
  public private(set) var state = "disconnected"
  public private(set) var connectedSessionId: String?

  private var socket: TerminalSocket?
  private let baseURL: URL
  private let token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  public func connect(sessionId: String, cols: Int = 120, rows: Int = 40) {
    disconnect()
    connectedSessionId = sessionId
    output = ""

    let sock = TerminalSocket(
      baseURL: baseURL,
      token: token,
      onData: { [weak self] data in
        Task { @MainActor [weak self] in
          if let text = String(data: data, encoding: .utf8) {
            // Strip ANSI escape codes for basic text rendering
            let clean = text.replacingOccurrences(
              of: "\\x1b\\[[0-9;]*[a-zA-Z]",
              with: "",
              options: .regularExpression
            )
            self?.output += clean
            // Cap output at 100KB to prevent memory issues
            if let output = self?.output, output.count > 100_000 {
              self?.output = String(output.suffix(80_000))
            }
          }
        }
      },
      onStateChange: { [weak self] newState in
        Task { @MainActor [weak self] in
          switch newState {
          case .disconnected: self?.state = "disconnected"
          case .connecting: self?.state = "connecting"
          case .connected: self?.state = "connected"
          case .error(let msg): self?.state = "error: \(msg)"
          }
        }
      }
    )
    socket = sock

    Task {
      await sock.connect(sessionId: sessionId, cols: cols, rows: rows)
    }
  }

  public func disconnect() {
    Task {
      await socket?.disconnect()
    }
    socket = nil
    state = "disconnected"
    connectedSessionId = nil
  }

  public func sendInput(_ text: String) {
    Task {
      await socket?.send(text: text)
    }
  }

  public func resize(cols: Int, rows: Int) {
    Task {
      await socket?.resize(cols: cols, rows: rows)
    }
  }
}
