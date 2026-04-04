import SwiftUI

/// Terminal tab — real xterm-compatible terminal via SwiftTerm.
public struct TerminalTab: View {
  public let session: Session
  public var terminalState: String
  public var dataPipe: TerminalDataPipe?
  public var onSendData: (([UInt8]) -> Void)?
  public var onResize: ((Int, Int) -> Void)?
  public var onConnect: (() -> Void)?
  public var onDisconnect: (() -> Void)?

  public init(
    session: Session,
    terminalState: String = "disconnected",
    dataPipe: TerminalDataPipe? = nil,
    onSendData: (([UInt8]) -> Void)? = nil,
    onResize: ((Int, Int) -> Void)? = nil,
    onConnect: (() -> Void)? = nil,
    onDisconnect: (() -> Void)? = nil
  ) {
    self.session = session
    self.terminalState = terminalState
    self.dataPipe = dataPipe
    self.onSendData = onSendData
    self.onResize = onResize
    self.onConnect = onConnect
    self.onDisconnect = onDisconnect
  }

  private var isActive: Bool {
    session.status == .running || session.status == .paused || session.status == .awaitingInput
  }

  private var isConnected: Bool { terminalState == "connected" }
  private var isReconnecting: Bool { terminalState.hasPrefix("reconnecting") }

  public var body: some View {
    if isActive {
      VStack(spacing: 0) {
        terminalToolbar
        Divider()

        if let pipe = dataPipe, (isConnected || isReconnecting) {
          // Keep the terminal view alive during reconnection so scrollback is preserved
          TerminalEmulatorView(
            dataPipe: pipe,
            onSendData: { bytes in onSendData?(bytes) },
            onResize: { cols, rows in onResize?(cols, rows) }
          )
        } else {
          // Not yet connected — auto-connect on appear, show manual button as fallback
          VStack(spacing: 12) {
            ProgressView()
              .controlSize(.regular)
            Text("Connecting…")
              .font(.subheadline)
              .foregroundStyle(.secondary)
            Button {
              onConnect?()
            } label: {
              Label("Retry", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1)))
          .onAppear {
            onConnect?()
          }
        }
      }
    } else {
      // Container not running
      VStack(spacing: 12) {
        Image(systemName: "terminal")
          .font(.system(size: 36))
          .foregroundStyle(.tertiary)
        Text("Container not running")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        Text("Terminal is available for running sessions only")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var statusColor: Color {
    if isConnected { return .green }
    if isReconnecting { return .yellow }
    return .red
  }

  private var terminalToolbar: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(statusColor)
        .frame(width: 7, height: 7)
      Text(isConnected ? "Connected" : terminalState)
        .font(.caption)
        .foregroundStyle(.secondary)

      Spacer()

      if isConnected {
        Button {
          onDisconnect?()
        } label: {
          Label("Disconnect", systemImage: "xmark.circle")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      } else if isActive && !isReconnecting {
        Button {
          onConnect?()
        } label: {
          Label("Connect", systemImage: "play.circle")
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }
}

#Preview("Terminal — not running") {
  TerminalTab(session: MockData.complete)
    .frame(width: 500, height: 400)
}
