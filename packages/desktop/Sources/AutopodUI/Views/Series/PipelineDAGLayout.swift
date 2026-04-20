import Foundation
import CoreGraphics

/// Pure, testable DAG layout for pod series. Produces per-node positions and a
/// list of edges. The layout is layered (Sugiyama-style, simplified):
///
///   1. Rank every node. Roots (no parents) get rank 0; every other node gets
///      `max(rank(parent)) + 1`. Iterative fixed-point — safe even if parent
///      order in the input is arbitrary.
///   2. Group by rank → layers.
///   3. Within each layer, sort by (first parent's layer index, node id) so
///      edges tend not to cross.
///
/// Kept separate from SwiftUI so it can be unit-tested with plain `XCTest`.
public enum PipelineDAGLayout {

    public struct Input: Sendable {
        public let id: String
        public let parentIds: [String]
        public init(id: String, parentIds: [String]) {
            self.id = id
            self.parentIds = parentIds
        }
    }

    public struct Node: Sendable, Equatable {
        public let id: String
        public let rank: Int
        public let position: CGPoint
        public init(id: String, rank: Int, position: CGPoint) {
            self.id = id
            self.rank = rank
            self.position = position
        }
    }

    public struct Edge: Sendable, Equatable {
        public let from: String
        public let to: String
        public init(from: String, to: String) {
            self.from = from
            self.to = to
        }
    }

    public struct Result: Sendable {
        public let nodes: [Node]
        public let edges: [Edge]
        public let width: CGFloat
        public let height: CGFloat
    }

    public struct Metrics: Sendable {
        public var nodeWidth: CGFloat
        public var nodeHeight: CGFloat
        public var horizontalGap: CGFloat
        public var verticalGap: CGFloat
        public var paddingX: CGFloat
        public var paddingY: CGFloat

        public init(
            nodeWidth: CGFloat = 200,
            nodeHeight: CGFloat = 116,
            horizontalGap: CGFloat = 80,
            verticalGap: CGFloat = 24,
            paddingX: CGFloat = 24,
            paddingY: CGFloat = 24
        ) {
            self.nodeWidth = nodeWidth
            self.nodeHeight = nodeHeight
            self.horizontalGap = horizontalGap
            self.verticalGap = verticalGap
            self.paddingX = paddingX
            self.paddingY = paddingY
        }

        public static let `default` = Metrics()
    }

    /// Layout the DAG. Inputs may reference parents that aren't in `inputs` —
    /// those edges are dropped (treated as external roots).
    public static func layout(_ inputs: [Input], metrics: Metrics = .default) -> Result {
        let ids = Set(inputs.map(\.id))

        // Drop edges that reference unknown parents.
        let filtered = inputs.map { input in
            Input(id: input.id, parentIds: input.parentIds.filter { ids.contains($0) })
        }

        let ranks = computeRanks(filtered)

        // Group by rank (sorted ascending).
        let byRank = Dictionary(grouping: filtered, by: { ranks[$0.id] ?? 0 })
        let sortedLayers = byRank.keys.sorted()

        // Determine per-layer ordering. First layer: sort by id for stability.
        // Subsequent layers: sort by (first parent's index in its layer, id).
        var layerOrdering: [Int: [String]] = [:]
        for rank in sortedLayers {
            let nodesInLayer = byRank[rank] ?? []
            if rank == sortedLayers.first {
                layerOrdering[rank] = nodesInLayer.map(\.id).sorted()
                continue
            }
            let previousRank = rank - 1
            let previousOrder = layerOrdering[previousRank] ?? []
            let parentIndex: (String) -> Int = { parentId in
                previousOrder.firstIndex(of: parentId) ?? Int.max
            }
            let sorted = nodesInLayer.sorted { a, b in
                let aKey = a.parentIds.map(parentIndex).min() ?? Int.max
                let bKey = b.parentIds.map(parentIndex).min() ?? Int.max
                if aKey != bKey { return aKey < bKey }
                return a.id < b.id
            }
            layerOrdering[rank] = sorted.map(\.id)
        }

        // Compute positions.
        var nodes: [Node] = []
        var maxLayerCount = 0
        for rank in sortedLayers {
            maxLayerCount = max(maxLayerCount, layerOrdering[rank]?.count ?? 0)
        }

        for rank in sortedLayers {
            let ordering = layerOrdering[rank] ?? []
            let count = ordering.count
            // Vertically center this layer relative to the tallest layer.
            let layerHeight = CGFloat(count) * metrics.nodeHeight
                + CGFloat(max(0, count - 1)) * metrics.verticalGap
            let tallest = CGFloat(maxLayerCount) * metrics.nodeHeight
                + CGFloat(max(0, maxLayerCount - 1)) * metrics.verticalGap
            let startY = metrics.paddingY + (tallest - layerHeight) / 2
            for (i, id) in ordering.enumerated() {
                let x = metrics.paddingX
                    + CGFloat(rank) * (metrics.nodeWidth + metrics.horizontalGap)
                    + metrics.nodeWidth / 2
                let y = startY + CGFloat(i) * (metrics.nodeHeight + metrics.verticalGap)
                    + metrics.nodeHeight / 2
                nodes.append(Node(id: id, rank: rank, position: CGPoint(x: x, y: y)))
            }
        }

        let edges: [Edge] = filtered.flatMap { input in
            input.parentIds.map { Edge(from: $0, to: input.id) }
        }

        let layerCount = sortedLayers.count
        let totalWidth = metrics.paddingX * 2
            + CGFloat(layerCount) * metrics.nodeWidth
            + CGFloat(max(0, layerCount - 1)) * metrics.horizontalGap
        let totalHeight = metrics.paddingY * 2
            + CGFloat(maxLayerCount) * metrics.nodeHeight
            + CGFloat(max(0, maxLayerCount - 1)) * metrics.verticalGap

        return Result(nodes: nodes, edges: edges, width: totalWidth, height: totalHeight)
    }

    /// Compute a rank per node as the length of the longest path from any root.
    /// Uses iterative relaxation — safe for up to a few hundred nodes, which is
    /// more than any realistic series will ever hold.
    private static func computeRanks(_ inputs: [Input]) -> [String: Int] {
        var ranks: [String: Int] = [:]
        for input in inputs {
            if input.parentIds.isEmpty {
                ranks[input.id] = 0
            }
        }
        // Relax until no changes. Bounded by O(n * depth).
        var changed = true
        var iterations = 0
        let maxIterations = max(16, inputs.count * 4)
        while changed && iterations < maxIterations {
            changed = false
            iterations += 1
            for input in inputs {
                if input.parentIds.isEmpty { continue }
                let parentRanks = input.parentIds.compactMap { ranks[$0] }
                guard parentRanks.count == input.parentIds.count else { continue }
                let newRank = (parentRanks.max() ?? -1) + 1
                if ranks[input.id] != newRank {
                    ranks[input.id] = newRank
                    changed = true
                }
            }
        }
        // Any stragglers (e.g. orphaned cycles — shouldn't happen in a DAG)
        // default to rank 0.
        for input in inputs where ranks[input.id] == nil {
            ranks[input.id] = 0
        }
        return ranks
    }
}
