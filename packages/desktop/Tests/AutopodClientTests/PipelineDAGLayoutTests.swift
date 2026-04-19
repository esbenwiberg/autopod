import Testing
import CoreGraphics
@testable import AutopodUI

@Suite("PipelineDAGLayout")
struct PipelineDAGLayoutTests {

    @Test("Linear chain: 4 pods in a row")
    func linearChain() {
        let inputs: [PipelineDAGLayout.Input] = [
            .init(id: "a", parentIds: []),
            .init(id: "b", parentIds: ["a"]),
            .init(id: "c", parentIds: ["b"]),
            .init(id: "d", parentIds: ["c"]),
        ]
        let result = PipelineDAGLayout.layout(inputs)
        let ranks = Dictionary(uniqueKeysWithValues: result.nodes.map { ($0.id, $0.rank) })
        #expect(ranks["a"] == 0)
        #expect(ranks["b"] == 1)
        #expect(ranks["c"] == 2)
        #expect(ranks["d"] == 3)
        #expect(result.edges.count == 3)
    }

    @Test("Fan-out: one parent, three children in a column")
    func fanOut() {
        let inputs: [PipelineDAGLayout.Input] = [
            .init(id: "root", parentIds: []),
            .init(id: "c1", parentIds: ["root"]),
            .init(id: "c2", parentIds: ["root"]),
            .init(id: "c3", parentIds: ["root"]),
        ]
        let result = PipelineDAGLayout.layout(inputs)
        let ranks = Dictionary(uniqueKeysWithValues: result.nodes.map { ($0.id, $0.rank) })
        #expect(ranks["root"] == 0)
        #expect(ranks["c1"] == 1)
        #expect(ranks["c2"] == 1)
        #expect(ranks["c3"] == 1)
        // All three children share a column (same x), different rows.
        let children = result.nodes.filter { $0.rank == 1 }
        #expect(Set(children.map(\.position.x)).count == 1)
        #expect(Set(children.map(\.position.y)).count == 3)
        #expect(result.edges.count == 3)
    }

    @Test("Fan-in: two parents, one merge child")
    func fanIn() {
        let inputs: [PipelineDAGLayout.Input] = [
            .init(id: "p1", parentIds: []),
            .init(id: "p2", parentIds: []),
            .init(id: "merge", parentIds: ["p1", "p2"]),
        ]
        let result = PipelineDAGLayout.layout(inputs)
        let ranks = Dictionary(uniqueKeysWithValues: result.nodes.map { ($0.id, $0.rank) })
        #expect(ranks["p1"] == 0)
        #expect(ranks["p2"] == 0)
        #expect(ranks["merge"] == 1)
        // Two edges converge on merge.
        let incomingToMerge = result.edges.filter { $0.to == "merge" }
        #expect(incomingToMerge.count == 2)
    }

    @Test("Diamond: 1 -> {2, 3} -> 4")
    func diamond() {
        let inputs: [PipelineDAGLayout.Input] = [
            .init(id: "top", parentIds: []),
            .init(id: "left", parentIds: ["top"]),
            .init(id: "right", parentIds: ["top"]),
            .init(id: "merge", parentIds: ["left", "right"]),
        ]
        let result = PipelineDAGLayout.layout(inputs)
        let ranks = Dictionary(uniqueKeysWithValues: result.nodes.map { ($0.id, $0.rank) })
        #expect(ranks["top"] == 0)
        #expect(ranks["left"] == 1)
        #expect(ranks["right"] == 1)
        #expect(ranks["merge"] == 2)
        #expect(result.edges.count == 4)
    }

    @Test("Unknown parents are dropped rather than crashing")
    func unknownParents() {
        let inputs: [PipelineDAGLayout.Input] = [
            .init(id: "orphan", parentIds: ["does-not-exist"]),
        ]
        let result = PipelineDAGLayout.layout(inputs)
        #expect(result.nodes.count == 1)
        #expect(result.edges.isEmpty)
        // Orphan still gets a rank (0 since it has no resolvable parents).
        #expect(result.nodes[0].rank == 0)
    }
}
