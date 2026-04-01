import SwiftUI

/// Terminal tab — interactive shell into running containers.
/// Uses a basic text-based terminal. Can be upgraded to SwiftTerm later.
public struct TerminalTab: View {
  public let session: Session
  public var terminalOutput: String
  public var terminalState: String
  public var onInput: ((String) -> Void)?
  public var onConnect: (() -> Void)?
  public var onDisconnect: (() -> Void)?

  public init(
    session: Session,
    terminalOutput: String = "",
    terminalState: String = "disconnected",
    onInput: ((String) -> Void)? = nil,
    onConnect: (() -> Void)? = nil,
    onDisconnect: (() -> Void)? = nil
  ) {
    self.session = session
    self.terminalOutput = terminalOutput
    self.terminalState = terminalState
    self.onInput = onInput
    self.onConnect = onConnect
    self.onDisconnect = onDisconnect
  }

  @State private var inputText = ""

  private var isActive: Bool {
    session.status == .running || session.status == .paused || session.status == .awaitingInput
  }

  private var isConnected: Bool { terminalState == "connected" }

  public var body: some View {
    if isActive {
      VStack(spacing: 0) {
        // Toolbar
        terminalToolbar

        Divider()

        // Terminal output
        ScrollViewReader { proxy in
          ScrollView {
            Text(terminalOutput.isEmpty ? "Connected. Waiting for output…\n" : terminalOutput)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.green)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
              .id("bottom")
          }
          .background(.black)
          .onChange(of: terminalOutput) { _, _ in
            proxy.scrollTo("bottom", anchor: .bottom)
          }
        }

        // Input bar
        if isConnected {
          Divider()
          HStack(spacing: 8) {
            Text("$")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.green)
            TextField("Type command…", text: $inputText)
              .textFieldStyle(.plain)
              .font(.system(.caption, design: .monospaced))
              .onSubmit {
                let cmd = inputText + "\n"
                onInput?(cmd)
                inputText = ""
              }
          }
          .padding(8)
          .background(.black)
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

  private var terminalToolbar: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(isConnected ? .green : .red)
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
      } else if isActive {
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

#Preview("Terminal — connected") {
  TerminalTab(
    session: MockData.running,
    terminalOutput: "$ ls\nREADME.md  package.json  src/\n$ npm run build\n> my-app@1.0.0 build\n> tsc && vite build\n\nvite v5.0.0 building for production...\n✓ 42 modules transformed.\n",
    terminalState: "connected"
  )
  .frame(width: 600, height: 400)
}

#Preview("Terminal — not running") {
  TerminalTab(session: MockData.complete)
    .frame(width: 500, height: 400)
}
