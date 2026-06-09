import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

// MARK: - Toggle-off semantics

@Test func toggleOffCostCard() {
    var card: AnalyticsCardKind? = nil
    // First click selects
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
    // Second click on the same card deselects
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == nil)
}

@Test func toggleOffQualityCard() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == .quality)
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == nil)
}

@Test func toggleOffStatusCard() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == .status)
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == nil)
}

@Test func toggleOffMemoryCard() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .memory)
    #expect(card == .memory)
    card = MainView.toggleAnalyticsCard(card, tapping: .memory)
    #expect(card == nil)
}

// MARK: - Switch-drill semantics (no nil intermediate)

@Test func switchDrillCostToQuality() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
    // Clicking Quality while Cost is selected switches directly — no nil intermediate
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == .quality)
}

@Test func switchDrillQualityToStatus() {
    var card: AnalyticsCardKind? = .quality
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == .status)
}

@Test func switchDrillStatusToCost() {
    var card: AnalyticsCardKind? = .status
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
}

@Test func switchDrillModelsToMemory() {
    var card: AnalyticsCardKind? = .models
    card = MainView.toggleAnalyticsCard(card, tapping: .memory)
    #expect(card == .memory)
}

@Test func analyticsRightPaneRoutesMemoryDrill() {
    #expect(AnalyticsRightPaneView.drillRoute(for: .memory) == "memory")
}

@Test func unknownMemoryScopePreservesWireValue() {
    #expect(MemoryScope.unknown("team").label == "team")
}

// MARK: - filterPods for analytics

@Test func filterPodsReturnsEmptyForAnalytics() {
    let pods: [Pod] = []
    let result = MainView.filterPods(pods, for: .analytics)
    #expect(result.isEmpty)
}

// MARK: - Browse pods

@Test func browseRecentCapsArchiveButKeepsActionablePods() {
    let oldRunning = makeBrowsePod("running-old", status: .running, timestamp: 1)
    let terminalPods = (0..<12).map {
        makeBrowsePod("done-\($0)", status: .complete, timestamp: Double(100 + $0))
    }

    let result = MainView.visiblePods(
        [oldRunning] + terminalPods,
        selection: .all,
        browseScope: .recent,
        limit: 5
    )

    #expect(result.contains { $0.id == "running-old" })
    #expect(result.contains { $0.id == "done-11" })
    #expect(!result.contains { $0.id == "done-0" })
    #expect(result.count == 5)
}

@Test func browseRecentSearchUsesFullArchive() {
    let oldMatch = makeBrowsePod("old-match", timestamp: 1, task: "Find the archive needle")
    let recentPods = (0..<8).map {
        makeBrowsePod("recent-\($0)", timestamp: Double(100 + $0), task: "No match")
    }

    let result = MainView.visiblePods(
        [oldMatch] + recentPods,
        selection: .all,
        browseScope: .recent,
        query: "archive needle",
        limit: 3
    )

    #expect(result.map(\.id) == ["old-match"])
}

@Test func browseRecentKeepsDirectlySelectedArchivedPod() {
    let selected = makeBrowsePod("selected-old", timestamp: 1)
    let recentPods = (0..<8).map {
        makeBrowsePod("recent-\($0)", timestamp: Double(100 + $0))
    }

    let result = MainView.visiblePods(
        [selected] + recentPods,
        selection: .all,
        browseScope: .recent,
        selectedPodId: "selected-old",
        limit: 3
    )

    #expect(result.contains { $0.id == "selected-old" })
    #expect(result.count == 4)
}

@Test func browseArchiveShowsTheFullLoadedArchive() {
    let pods = (0..<8).map {
        makeBrowsePod("pod-\($0)", timestamp: Double($0))
    }

    let result = MainView.visiblePods(pods, selection: .all, browseScope: .archive, limit: 3)

    #expect(result.count == pods.count)
}

// MARK: - onSelectPod handler

@Test func analyticsSelectPodClearsCardAndNavigates() {
    let result = MainView.analyticsSelectPodResult(sessionId: "abc123")
    #expect(result.card == nil)
    #expect(result.sidebar == .all)
    #expect(result.session == "abc123")
}

@Test func analyticsSelectPodWithDifferentSessionId() {
    let result = MainView.analyticsSelectPodResult(sessionId: "xyz-pod-9876")
    #expect(result.card == nil)
    #expect(result.sidebar == .all)
    #expect(result.session == "xyz-pod-9876")
}

private func makeBrowsePod(
    _ id: String,
    status: PodStatus = .complete,
    timestamp: Double,
    task: String = "Task"
) -> Pod {
    let date = Date(timeIntervalSince1970: timestamp)
    return Pod(
        id: id,
        status: status,
        branch: "branch-\(id)",
        profileName: "profile",
        task: task,
        model: "claude",
        startedAt: date,
        updatedAt: date
    )
}
