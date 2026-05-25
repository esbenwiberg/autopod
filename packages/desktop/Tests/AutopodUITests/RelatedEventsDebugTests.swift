import Foundation
import Testing
@testable import AutopodUI

private func makePod(
    _ id: String,
    linkedSessionId: String? = nil,
    fixPodId: String? = nil,
    seriesId: String? = nil,
    dependsOnPodIds: [String] = []
) -> Pod {
    Pod(
        id: id,
        status: .running,
        branch: "autopod/\(id)",
        profileName: "default",
        model: "test-model",
        startedAt: Date(timeIntervalSince1970: 0),
        linkedSessionId: linkedSessionId,
        fixPodId: fixPodId,
        seriesId: seriesId,
        dependsOnPodIds: dependsOnPodIds
    )
}

@Test func relatedEventReferencesAreEmptyForStandalonePods() {
    let pod = makePod("current")

    let references = DetailPanelView.relatedEventReferences(for: pod, seriesPods: [])

    #expect(references.isEmpty)
}

@Test func relatedEventReferencesIncludeLinkedFixAndSeriesPodsWithoutDuplicates() {
    let current = makePod(
        "current",
        linkedSessionId: "parent",
        fixPodId: "fix",
        seriesId: "series-1",
        dependsOnPodIds: ["parent"]
    )
    let parent = makePod("parent", seriesId: "series-1")
    let fix = makePod("fix", seriesId: "series-1")
    let child = makePod("child", seriesId: "series-1", dependsOnPodIds: ["current"])
    let sibling = makePod("sibling", seriesId: "series-1")

    let references = DetailPanelView.relatedEventReferences(
        for: current,
        seriesPods: [current, parent, fix, child, sibling]
    )

    #expect(references.map(\.id) == ["parent", "fix", "child", "sibling"])

    let relationships = Dictionary(uniqueKeysWithValues: references.map { ($0.id, $0.relationship) })
    #expect(relationships["parent"] == "parent pod")
    #expect(relationships["fix"] == "current fix pod")
    #expect(relationships["child"] == "series child")
    #expect(relationships["sibling"] == "series sibling")
}
