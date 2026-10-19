import SwiftUI

struct PodLifecycleRail: View {
    let pod: Pod
    private var current: Int? { pod.desktopLifecycleStage.flatMap { pod.desktopLifecycleStages.firstIndex(of: $0) } }
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(pod.desktopLifecycleStages.enumerated()), id: \.offset) { index, stage in
                Capsule().fill(color(index)).frame(height: 3).help(stage.rawValue)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Autopod lifecycle: \(pod.desktopLifecycleStage?.rawValue ?? pod.status.label)")
    }
    private func color(_ index: Int) -> Color {
        guard let current else { return DesktopTheme.line }
        return index == current ? DesktopTheme.accent : index < current ? DesktopTheme.accent.opacity(0.45) : DesktopTheme.line
    }
}

struct ReportedMilestoneView: View {
    let phase: PhaseProgress
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("CURRENT REPORTED MILESTONE").font(.system(size: 9, weight: .medium)).tracking(1).foregroundStyle(.secondary)
                Text(phase.description).font(.callout.weight(.medium)).textSelection(.enabled)
                Text("Agent-reported progress · plan steps remain in Work").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if phase.total > 0, phase.current >= 0, phase.current <= phase.total {
                Text("M\(phase.current)/\(phase.total)")
                    .font(.system(.caption, design: .monospaced)).monospacedDigit()
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 4))
            } else { Text("Unavailable").font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 16)
        .overlay(alignment: .top) { DesktopTheme.line.frame(height: 1) }
        .overlay(alignment: .bottom) { DesktopTheme.line.frame(height: 1) }
    }
}
