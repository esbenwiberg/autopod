import SwiftUI

/// Slide-in activity panel shown when a pipeline node is selected in SeriesPipelineView.
struct PodActivityPanel: View {
    let pod: Pod
    var actions: PodActions
    var onNavigate: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            panelHeader
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    metaRow
                    if let activity = pod.latestActivity {
                        activitySection(activity)
                    }
                    if let phase = pod.phase {
                        phaseSection(phase)
                    }
                    if pod.status.isActive || pod.status.needsAttention {
                        actionButtons
                    }
                }
                .padding(12)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var panelHeader: some View {
        HStack(spacing: 6) {
            StatusDot(status: pod.status)
            Text(pod.id)
                .font(.system(.callout, design: .monospaced).weight(.semibold))
                .lineLimit(1)
            Spacer()
            Button {
                onNavigate?()
            } label: {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 13))
                    .foregroundStyle(.blue)
            }
            .buttonStyle(.plain)
            .help("Open pod detail")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var metaRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(pod.status.label)
                    .font(.caption)
                    .foregroundStyle(pod.status.color)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(pod.duration)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Text(pod.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(pod.model)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if pod.costUsd > 0 {
                Text(String(format: "$%.2f", pod.costUsd))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func activitySection(_ activity: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Activity")
                .font(.system(.caption2).weight(.semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
            Text(activity)
                .font(.system(.caption))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func phaseSection(_ phase: PhaseProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Progress")
                .font(.system(.caption2).weight(.semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
            ProgressView(value: Double(phase.current), total: Double(max(phase.total, 1)))
                .progressViewStyle(.linear)
                .tint(.blue)
            Text(phase.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            if pod.status != .paused {
                Button("Nudge") {
                    Task { await actions.nudge(pod.id, "") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if pod.status.isActive {
                Button("Pause") {
                    Task { await actions.pause(pod.id) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }
}
