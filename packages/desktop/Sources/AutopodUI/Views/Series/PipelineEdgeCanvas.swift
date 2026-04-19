import SwiftUI

/// Draws dependency edges (arrows) between DAG nodes. Edge color reflects the
/// dependency gate state:
///   - green: parent validated, child has moved past queued
///   - red:   parent failed and blocked the child
///   - gray:  parent not yet validated / child still queued
public struct PipelineEdgeCanvas: View {
    public struct EdgeStyle {
        public let from: String
        public let to: String
        public let color: Color
        public init(from: String, to: String, color: Color) {
            self.from = from
            self.to = to
            self.color = color
        }
    }

    public let edges: [EdgeStyle]
    public let nodePositions: [String: CGPoint]
    public let nodeSize: CGSize

    public init(edges: [EdgeStyle], nodePositions: [String: CGPoint], nodeSize: CGSize) {
        self.edges = edges
        self.nodePositions = nodePositions
        self.nodeSize = nodeSize
    }

    public var body: some View {
        Canvas { context, _ in
            for edge in edges {
                guard let from = nodePositions[edge.from],
                      let to = nodePositions[edge.to] else { continue }
                // Right edge of source → left edge of target.
                let start = CGPoint(x: from.x + nodeSize.width / 2, y: from.y)
                let end = CGPoint(x: to.x - nodeSize.width / 2, y: to.y)
                let dx = end.x - start.x
                let cp1 = CGPoint(x: start.x + dx * 0.5, y: start.y)
                let cp2 = CGPoint(x: end.x - dx * 0.5, y: end.y)

                var path = Path()
                path.move(to: start)
                path.addCurve(to: end, control1: cp1, control2: cp2)
                context.stroke(path, with: .color(edge.color.opacity(0.8)), lineWidth: 1.5)

                // Arrowhead at target.
                drawArrowhead(context: context, at: end, from: cp2, color: edge.color)
            }
        }
        .allowsHitTesting(false)
    }

    private func drawArrowhead(context: GraphicsContext, at end: CGPoint, from control: CGPoint, color: Color) {
        let dx = end.x - control.x
        let dy = end.y - control.y
        let angle = atan2(dy, dx)
        let size: CGFloat = 8
        let p1 = CGPoint(
            x: end.x - size * cos(angle - .pi / 6),
            y: end.y - size * sin(angle - .pi / 6)
        )
        let p2 = CGPoint(
            x: end.x - size * cos(angle + .pi / 6),
            y: end.y - size * sin(angle + .pi / 6)
        )
        var head = Path()
        head.move(to: end)
        head.addLine(to: p1)
        head.move(to: end)
        head.addLine(to: p2)
        context.stroke(head, with: .color(color.opacity(0.85)), lineWidth: 1.5)
    }
}
