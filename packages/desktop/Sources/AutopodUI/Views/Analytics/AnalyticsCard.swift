import SwiftUI

// MARK: - Delta

/// Direction indicator and label for a card's delta line.
public struct AnalyticsCardDelta {
    public enum Direction { case up, down, flat }

    public let value: String      // e.g. "+18%"
    public let direction: Direction

    public init(value: String, direction: Direction) {
        self.value = value
        self.direction = direction
    }
}

extension AnalyticsCardDelta.Direction {
    fileprivate var systemImage: String {
        switch self {
        case .up:   "arrow.up.right"
        case .down: "arrow.down.right"
        case .flat: "arrow.right"
        }
    }

    fileprivate var color: Color {
        switch self {
        case .up:   .green
        case .down: .red
        case .flat: .secondary
        }
    }
}

// MARK: - Card

/// A clickable summary tile for the Analytics Overview card grid.
/// `StatTile` (informational) and `AnalyticsCard` (clickable) are deliberately
/// separate types — do not merge them.
public struct AnalyticsCard: View {
    public let title: String
    public let value: String
    /// When non-nil, renders a mini sparkline below the value. `nil` hides
    /// the sparkline entirely — no reserved space.
    public let sparkline: [Double]?
    /// When non-nil, renders a direction arrow + value string. `nil` hides it.
    public let delta: AnalyticsCardDelta?
    /// Optional secondary label rendered below the delta line (e.g. "3 red pods").
    public let subline: String?
    public let isSelected: Bool
    public let onClick: () -> Void

    public init(
        title: String,
        value: String,
        sparkline: [Double]? = nil,
        delta: AnalyticsCardDelta? = nil,
        subline: String? = nil,
        isSelected: Bool = false,
        onClick: @escaping () -> Void
    ) {
        self.title = title
        self.value = value
        self.sparkline = sparkline
        self.delta = delta
        self.subline = subline
        self.isSelected = isSelected
        self.onClick = onClick
    }

    @State private var isHovered = false

    public var body: some View {
        Button(action: onClick) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)

                Text(value)
                    .font(.largeTitle.bold())

                if let sparkline {
                    CardSparklineView(values: sparkline)
                        .frame(height: 36)
                }

                if let delta {
                    HStack(spacing: 4) {
                        Image(systemName: delta.direction.systemImage)
                        Text(delta.value)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(delta.direction.color)
                }

                if let subline {
                    Text(subline)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(
                    color: .black.opacity(isSelected ? 0.10 : isHovered ? 0.08 : 0.03),
                    radius: isSelected ? 10 : isHovered ? 8 : 3,
                    y: isSelected ? 3 : isHovered ? 2 : 1
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(
                    isSelected ? Color.accentColor : Color.white.opacity(0.15),
                    lineWidth: isSelected ? 2 : 1.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .animation(.easeOut(duration: 0.15), value: isSelected)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Sparkline

/// Path-based mini line chart — purely decorative, no axes or labels.
/// (Charts is not in Package.swift; uses same GeometryReader + Path pattern
/// as SparklineView in AnalyticsView.swift. Add Charts dep to switch.)
private struct CardSparklineView: View {
    let values: [Double]

    var body: some View {
        if values.count > 1 {
            GeometryReader { geo in
                let minV = values.min() ?? 0
                let maxV = values.max() ?? 1
                let range = maxV - minV > 0 ? maxV - minV : 1
                let w = geo.size.width
                let h = geo.size.height
                let step = w / CGFloat(values.count - 1)

                ZStack(alignment: .bottomLeading) {
                    areaPath(step: step, w: w, h: h, minV: minV, range: range)
                        .fill(Color.accentColor.opacity(0.10))
                    linePath(step: step, h: h, minV: minV, range: range)
                        .stroke(
                            Color.accentColor.opacity(0.6),
                            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
                        )
                }
            }
        }
    }

    private func linePath(step: CGFloat, h: CGFloat, minV: Double, range: Double) -> Path {
        Path { path in
            for (i, v) in values.enumerated() {
                let x = CGFloat(i) * step
                let y = h - CGFloat((v - minV) / range) * h
                if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }
        }
    }

    private func areaPath(step: CGFloat, w: CGFloat, h: CGFloat, minV: Double, range: Double) -> Path {
        var path = linePath(step: step, h: h, minV: minV, range: range)
        path.addLine(to: CGPoint(x: w, y: h))
        path.addLine(to: CGPoint(x: 0, y: h))
        path.closeSubpath()
        return path
    }
}

// MARK: - Preview

#Preview("AnalyticsCard — unselected, no sparkline") {
    AnalyticsCard(
        title: "Total Cost",
        value: "$12.40",
        isSelected: false,
        onClick: {}
    )
    .frame(width: 200)
    .padding()
}

#Preview("AnalyticsCard — selected, sparkline + delta") {
    AnalyticsCard(
        title: "Quality Score",
        value: "82",
        sparkline: [1, 3, 2, 5, 4, 6],
        delta: AnalyticsCardDelta(value: "+18%", direction: .up),
        isSelected: true,
        onClick: {}
    )
    .frame(width: 200)
    .padding()
}
