import SwiftUI

/// Terminal tab — interactive shell into running containers.
/// Requires daemon WS /sessions/:id/terminal endpoint (not yet implemented).
/// This is a placeholder that shows the correct UI states.
public struct TerminalTab: View {
  public let session: Session
  public init(session: Session) { self.session = session }

  public var body: some View {
    VStack(spacing: 12) {
      if session.status.isActive {
        // Container is running — would connect terminal here
        Image(systemName: "terminal")
          .font(.system(size: 36))
          .foregroundStyle(.green)
        Text("Terminal")
          .font(.headline)
        Text("Interactive terminal requires the daemon terminal WebSocket endpoint.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Text("WS /sessions/\(session.id)/terminal")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.tertiary)
          .padding(6)
          .background(Color(nsColor: .controlBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 4))
      } else {
        // Container not running
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
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

#Preview("Terminal — running") {
  TerminalTab(session: MockData.running)
    .frame(width: 500, height: 400)
}

#Preview("Terminal — not running") {
  TerminalTab(session: MockData.complete)
    .frame(width: 500, height: 400)
}
