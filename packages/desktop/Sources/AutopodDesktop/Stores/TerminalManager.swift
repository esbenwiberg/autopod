import Foundation
import AutopodClient
import AutopodUI

/// Manages terminal WebSocket connections for session detail views.
/// Feeds raw PTY bytes into a TerminalDataPipe for SwiftTerm rendering.
@Observable
@MainActor
public final class TerminalManager {

  public private(set) var state = "disconnected"
  public private(set) var connectedSessionId: String?
  public let dataPipe = TerminalDataPipe()

  private var socket: TerminalSocket?
  private let baseURL: URL
  private let token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  public func connect(sessionId: String, cols: Int = 120, rows: Int = 40) {
    // Guard against double-connect: multiple code paths can trigger connect
    // for the same session (e.g. attachTerminal action + tab onChange). Two
    // simultaneous connections to the same tmux session cause doubled output
    // because tmux sends data to both attached clients.
    if connectedSessionId == sessionId && (state == "connected" || state == "connecting") {
      return
    }
    disconnect()
    connectedSessionId = sessionId

    let pipe = dataPipe
    let sock = TerminalSocket(
      baseURL: baseURL,
      token: token,
      onData: { data in
        Task { @MainActor in
          pipe.feed(data)
        }
      },
      onStateChange: { [weak self] newState in
        Task { @MainActor [weak self] in
          switch newState {
          case .disconnected: self?.state = "disconnected"
          case .connecting: self?.state = "connecting"
          case .connected: self?.state = "connected"
          case .reconnecting(let attempt): self?.state = "reconnecting (\(attempt))"
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
    let oldSocket = socket
    socket = nil
    state = "disconnected"
    connectedSessionId = nil
    if let oldSocket {
      Task { await oldSocket.disconnect() }
    }
  }

  public func sendData(_ bytes: [UInt8]) {
    Task {
      await socket?.send(data: Data(bytes))
    }
  }

  public func resize(cols: Int, rows: Int) {
    Task {
      await socket?.resize(cols: cols, rows: rows)
    }
  }
}
