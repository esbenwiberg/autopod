import SwiftUI

struct AgentPhaseProgressView: View {
    enum Variant {
        case compact
        case detailed
    }

    let phase: PhaseProgress
    var variant: Variant = .compact
    var showChrome: Bool = true

    private var safeTotal: Int { max(phase.total, 1) }
    private var safeCurrent: Int { min(max(phase.current, 0), safeTotal) }
    private var markerLimit: Int { 12 }
    private var accent: Color { .accentColor }

    var body: some View {
        Group {
            if showChrome {
                content
                    .padding(14)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                content
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: variant == .compact ? 8 : 10) {
            header

            ProgressView(value: Double(safeCurrent), total: Double(safeTotal))
                .progressViewStyle(.linear)
                .tint(accent)
                .animation(.easeOut(duration: 0.2), value: safeCurrent)

            if safeTotal > 1 && safeTotal <= markerLimit {
                markers
            }

            Text(phase.description)
                .font(variant == .compact ? .caption : .callout)
                .foregroundStyle(variant == .compact ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if variant == .detailed {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(accent)
            }

            Text("Progress")
                .font(.system(.subheadline).weight(.semibold))

            Spacer(minLength: 8)

            Text("\(safeCurrent) of \(safeTotal)")
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(accent)
                .monospacedDigit()
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(accent.opacity(0.12), in: Capsule())
        }
    }

    private var markers: some View {
        HStack(spacing: 0) {
            ForEach(1...safeTotal, id: \.self) { step in
                Circle()
                    .fill(markerColor(for: step))
                    .frame(width: markerDiameter, height: markerDiameter)

                if step < safeTotal {
                    Rectangle()
                        .fill(connectorColor(after: step))
                        .frame(height: 1)
                }
            }
        }
    }

    private var markerDiameter: CGFloat {
        variant == .compact ? 5 : 6
    }

    private func markerColor(for step: Int) -> Color {
        if step <= safeCurrent {
            return accent
        }
        return Color(nsColor: .separatorColor)
    }

    private func connectorColor(after step: Int) -> Color {
        if step < safeCurrent {
            return accent.opacity(0.42)
        }
        return Color(nsColor: .separatorColor).opacity(0.35)
    }
}
