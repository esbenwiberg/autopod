import SwiftUI

/// Compact pod node for the series pipeline DAG. ~200×96 to match the
/// `PipelineDAGLayout.Metrics.default`.
public struct PipelineNodeView: View {
    public let pod: Pod
    public let isSelected: Bool
    public let onTap: () -> Void

    public init(pod: Pod, isSelected: Bool = false, onTap: @escaping () -> Void = {}) {
        self.pod = pod
        self.isSelected = isSelected
        self.onTap = onTap
    }

    @State private var isHovered = false

    private var title: String {
        let first = pod.task.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = first.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? pod.branch : trimmed
    }

    private var costLabel: String {
        pod.costUsd > 0 ? String(format: "$%.2f", pod.costUsd) : "—"
    }

    public var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    StatusDot(status: pod.status)
                    Text(title)
                        .font(.system(.subheadline).weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    Text(pod.duration)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                HStack(spacing: 6) {
                    Text(pod.status.label)
                        .font(.caption)
                        .foregroundStyle(pod.status.color)
                    Spacer()
                    Text(costLabel)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                if let diff = pod.diffStats {
                    HStack(spacing: 6) {
                        Text("+\(diff.added)")
                            .foregroundStyle(.green)
                        Text("-\(diff.removed)")
                            .foregroundStyle(.red)
                        Text("\(diff.files) files")
                            .foregroundStyle(.tertiary)
                        Spacer()
                        if let url = pod.prUrl {
                            Link(destination: url) {
                                Label("PR", systemImage: "arrow.up.right.square")
                                    .font(.caption2)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.blue)
                        }
                    }
                    .font(.system(.caption2, design: .monospaced))
                } else if let url = pod.prUrl {
                    HStack(spacing: 6) {
                        Spacer()
                        Link(destination: url) {
                            Label("PR", systemImage: "arrow.up.right.square")
                                .font(.caption2)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.blue)
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .shadow(color: .black.opacity(isSelected ? 0.15 : 0.05),
                            radius: isSelected ? 6 : 2, y: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(
                        isSelected
                            ? Color.accentColor
                            : isHovered
                                ? Color.accentColor.opacity(0.4)
                                : pod.status.color.opacity(0.25),
                        lineWidth: isSelected ? 2 : 1.25
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .animation(.easeOut(duration: 0.12), value: isSelected)
    }
}
