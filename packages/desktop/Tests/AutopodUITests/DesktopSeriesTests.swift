import Foundation
import Testing
@testable import AutopodUI

private func member(_ id: String, _ status: PodStatus, series: String = "recovery") -> Pod {
    Pod(id: id, status: status, branch: "fix/\(id)", profileName: "sample", model: "test", startedAt: .distantPast, seriesId: series)
}

@Test func seriesProgressDoesNotCountFailuresAsCompletion() {
    let pods = [member("done", .complete), member("failed", .failed), member("killed", .killed), member("queued", .queued)]
    let group = DesktopSeriesGroup.groups(pods)[0]
    #expect(group.completedCount == 1)
    #expect(group.failedCount == 2)
    #expect(group.queuedCount == 1)
    #expect(group.completion == 0.25)
}

@Test func failedSeriesStayVisibleWhileSuccessfulArchiveIsOptional() {
    let pods = [member("failed", .failed), member("done", .complete, series: "delivered")]
    #expect(DesktopSeriesGroup.groups(pods).map(\.id) == ["recovery"])
    #expect(DesktopSeriesGroup.groups(pods, includeCompleted: true).count == 2)
}

@Test func legacySeriesDetailSelectionFallsBackForSeriesMembers() {
    let pod = member("member", .running)
    #expect(!DetailPanelView.isTabSelectable(.series, for: pod, evidenceAvailable: true, terminalAvailable: false))
    #expect(DetailPanelView.selectedTabAfterPodChange(currentTab: .series, pod: pod, evidenceAvailable: true, terminalAvailable: false) == .overview)
}
