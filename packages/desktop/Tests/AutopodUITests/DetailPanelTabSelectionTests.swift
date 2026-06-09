import Foundation
import Testing
@testable import AutopodUI

private func makeTabSelectionPod(
    _ id: String,
    pod: PodConfig = PodConfig(),
    seriesId: String? = nil
) -> Pod {
    Pod(
        id: id,
        status: .running,
        pod: pod,
        branch: "autopod/\(id)",
        profileName: "default",
        model: "test-model",
        startedAt: Date(timeIntervalSince1970: 0),
        seriesId: seriesId
    )
}

@Test func detailTabSelectionKeepsDiffWhenSwitchingPods() {
    let pod = makeTabSelectionPod("next")

    let tab = DetailPanelView.selectedTabAfterPodChange(
        currentTab: .diff,
        pod: pod,
        evidenceAvailable: false,
        terminalAvailable: false
    )

    #expect(tab == .diff)
}

@Test func detailTabSelectionFallsBackWhenSeriesTabIsUnavailable() {
    let pod = makeTabSelectionPod("standalone")

    let tab = DetailPanelView.selectedTabAfterPodChange(
        currentTab: .series,
        pod: pod,
        evidenceAvailable: false,
        terminalAvailable: false
    )

    #expect(tab == .overview)
}

@Test func detailTabSelectionFallsBackWhenTerminalIsUnavailable() {
    let pod = makeTabSelectionPod("worker")

    let tab = DetailPanelView.selectedTabAfterPodChange(
        currentTab: .terminal,
        pod: pod,
        evidenceAvailable: false,
        terminalAvailable: false
    )

    #expect(tab == .overview)
}

@Test func seriesPodsDefaultToOverview() {
    let pod = makeTabSelectionPod("series-root", seriesId: "series-1")

    #expect(DetailPanelView.defaultTab(for: pod) == .overview)
}

@Test func artifactPodsDefaultToEvidence() {
    let pod = makeTabSelectionPod(
        "artifact",
        pod: PodConfig(agentMode: .auto, output: .artifact, validate: false)
    )

    #expect(DetailPanelView.defaultTab(for: pod) == .evidence)
}
