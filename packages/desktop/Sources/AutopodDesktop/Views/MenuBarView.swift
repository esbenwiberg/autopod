import SwiftUI
import AutopodUI

/// Menubar dropdown showing fleet status at a glance.
public struct MenuBarView: View {
  public let pods: [Pod]
  public var actions: PodActions
  public var onOpenDashboard: () -> Void = {}

  public init(pods: [Pod], actions: PodActions = .preview, onOpenDashboard: @escaping () -> Void = {}) {
    self.pods = pods; self.actions = actions; self.onOpenDashboard = onOpenDashboard
  }

  private var attentionSessions: [Pod] {
    pods.filter { $0.status.needsAttention }
  }

  private var runningSessions: [Pod] {
    pods.filter { $0.status.isActive }
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

      // Attention pods
      if !attentionSessions.isEmpty {
        ForEach(attentionSessions.prefix(5)) { pod in
          menuSessionRow(pod)
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

  private func menuSessionRow(_ pod: Pod) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(pod.status.color)
        .frame(width: 6, height: 6)
      Text(pod.branch)
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
      Spacer()
      Text(pod.status.label)
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 3)
  }
}
