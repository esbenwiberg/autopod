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
/// When `Metrics.maxColumns` is set AND the graph is a purely linear chain,
/// a snake layout is used instead: nodes wrap into rows like text, with
/// alternating left-to-right / right-to-left direction per row.
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
        /// When set, linear chains wrap into rows of this many columns (snake layout).
        public var maxColumns: Int?

        public init(
            nodeWidth: CGFloat = 200,
            nodeHeight: CGFloat = 116,
            horizontalGap: CGFloat = 80,
            verticalGap: CGFloat = 24,
            paddingX: CGFloat = 24,
            paddingY: CGFloat = 24,
            maxColumns: Int? = nil
        ) {
            self.nodeWidth = nodeWidth
            self.nodeHeight = nodeHeight
            self.horizontalGap = horizontalGap
            self.verticalGap = verticalGap
            self.paddingX = paddingX
            self.paddingY = paddingY
            self.maxColumns = maxColumns
        }

        public static let `default` = Metrics()

        /// Vertical gap between wrapped rows — same as horizontalGap for visual balance.
        var verticalRowGap: CGFloat { horizontalGap }
    }

    /// Layout the DAG. Inputs may reference parents that aren't in `inputs` —
    /// those edges are dropped (treated as external roots).
    public static func layout(_ inputs: [Input], metrics: Metrics = .default) -> Result {
        let ids = Set(inputs.map(\.id))

        // Drop edges that reference unknown parents.
        let filtered = inputs.map { input in
            Input(id: input.id, parentIds: input.parentIds.filter { ids.contains($0) })
        }

        // Use snake layout for linear chains when maxColumns is set.
        if let maxCols = metrics.maxColumns,
           let sorted = sortedLinearChain(filtered) {
            return layoutSnake(sorted, metrics: metrics, maxCols: maxCols)
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

    // MARK: - Snake layout (linear chains only)

    /// Returns nodes sorted root-first if the DAG is a purely linear chain
    /// (each node has at most one parent and one child, with a single root).
    /// Returns nil for branching DAGs, which use the Sugiyama layout instead.
    static func sortedLinearChain(_ inputs: [Input]) -> [Input]? {
        guard !inputs.isEmpty else { return [] }

        // Each node must have at most one parent.
        guard inputs.allSatisfy({ $0.parentIds.count <= 1 }) else { return nil }

        // Each node must have at most one child.
        var childCounts: [String: Int] = [:]
        for input in inputs {
            for parentId in input.parentIds {
                childCounts[parentId, default: 0] += 1
            }
        }
        guard inputs.allSatisfy({ childCounts[$0.id, default: 0] <= 1 }) else { return nil }

        // Exactly one root.
        let roots = inputs.filter { $0.parentIds.isEmpty }
        guard roots.count == 1 else { return nil }

        // Follow the chain from root to end.
        let byId = Dictionary(uniqueKeysWithValues: inputs.map { ($0.id, $0) })
        let childOf = Dictionary(
            uniqueKeysWithValues: inputs.compactMap { input -> (String, String)? in
                guard let parentId = input.parentIds.first else { return nil }
                return (parentId, input.id)
            }
        )

        var sorted: [Input] = []
        var current: String? = roots[0].id
        while let id = current {
            guard let input = byId[id] else { break }
            sorted.append(input)
            current = childOf[id]
        }

        guard sorted.count == inputs.count else { return nil }
        return sorted
    }

    /// Snake layout: folds a linear chain into rows of `maxCols`, alternating
    /// direction each row (left→right, right→left, left→right, …).
    private static func layoutSnake(_ sorted: [Input], metrics: Metrics, maxCols: Int) -> Result {
        let numNodes = sorted.count
        var nodes: [Node] = []

        for (rank, input) in sorted.enumerated() {
            let row = rank / maxCols
            let col = rank % maxCols
            let isOddRow = row % 2 != 0
            let visualCol = isOddRow ? (maxCols - 1 - col) : col

            let x = metrics.paddingX
                + CGFloat(visualCol) * (metrics.nodeWidth + metrics.horizontalGap)
                + metrics.nodeWidth / 2
            let y = metrics.paddingY
                + CGFloat(row) * (metrics.nodeHeight + metrics.verticalRowGap)
                + metrics.nodeHeight / 2

            nodes.append(Node(id: input.id, rank: rank, position: CGPoint(x: x, y: y)))
        }

        let edges: [Edge] = sorted.compactMap { input -> Edge? in
            guard let parentId = input.parentIds.first else { return nil }
            return Edge(from: parentId, to: input.id)
        }

        let numRows = (numNodes + maxCols - 1) / maxCols
        let actualCols = min(maxCols, numNodes)

        let width = metrics.paddingX * 2
            + CGFloat(actualCols) * metrics.nodeWidth
            + CGFloat(max(0, actualCols - 1)) * metrics.horizontalGap
        let height = metrics.paddingY * 2
            + CGFloat(numRows) * metrics.nodeHeight
            + CGFloat(max(0, numRows - 1)) * metrics.verticalRowGap

        return Result(nodes: nodes, edges: edges, width: width, height: height)
    }

    // MARK: - Rank computation

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
