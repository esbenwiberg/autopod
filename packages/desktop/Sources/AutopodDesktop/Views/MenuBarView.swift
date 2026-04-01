import SwiftUI
import AutopodUI

/// Menubar dropdown showing fleet status at a glance.
public struct MenuBarView: View {
  public let sessions: [Session]
  public var actions: SessionActions
  public var onOpenDashboard: () -> Void = {}

  public init(sessions: [Session], actions: SessionActions = .preview, onOpenDashboard: @escaping () -> Void = {}) {
    self.sessions = sessions; self.actions = actions; self.onOpenDashboard = onOpenDashboard
  }

  private var attentionSessions: [Session] {
    sessions.filter { $0.status.needsAttention }
  }

  private var runningSessions: [Session] {
    sessions.filter { $0.status.isActive }
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Header
      HStack {
        Text("Autopod")
          .font(.headline)
        Spacer()
        if !attentionSessions.isEmpty {
          Text("\(attentionSessions.count) need attention")
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)

      Divider()

      // Attention sessions
      if !attentionSessions.isEmpty {
        ForEach(attentionSessions.prefix(5)) { session in
          menuSessionRow(session)
        }
        Divider()
      }

      // Running count
      if !runningSessions.isEmpty {
        HStack {
          Text("\(runningSessions.count) running")
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        Divider()
      }

      // Actions
      Button {
        onOpenDashboard()
      } label: {
        Label("Open Dashboard", systemImage: "macwindow")
      }
      .buttonStyle(.borderless)
      .padding(.horizontal, 12)
      .padding(.vertical, 4)

      if !attentionSessions.isEmpty {
        Button {
          Task { await actions.approveAll() }
        } label: {
          Label("Approve All Validated", systemImage: "checkmark.circle")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
      }
    }
    .frame(width: 280)
    .padding(.vertical, 4)
  }

  private func menuSessionRow(_ session: Session) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(session.status.color)
        .frame(width: 6, height: 6)
      Text(session.branch)
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
      Spacer()
      Text(session.status.label)
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 3)
  }
}
