import AppKit
import AutopodClient
@testable import AutopodUI
import SwiftUI
import Testing
@testable import AutopodDesktop

@MainActor @Test func analyticsFixturesDecodeEveryDrillAndWindow() throws {
    for days in [7, 14, 30, 60, 90] {
        #expect(try DesktopAnalyticsFixtures.cost(days).total > 0)
        #expect(try DesktopAnalyticsFixtures.reliability(days).summary.totalPodsInWindow > 0)
        #expect(try DesktopAnalyticsFixtures.quality(days).summary.totalPodsScored > 0)
        #expect(try DesktopAnalyticsFixtures.safety(days).summary.totalEvents > 0)
        #expect(try DesktopAnalyticsFixtures.throughput(days).summary.podsPerDay > 0)
        #expect(try DesktopAnalyticsFixtures.escalations(days).summary.cohortSize > 0)
        #expect(try DesktopAnalyticsFixtures.models(days).byModel.count >= 2)
        #expect(try DesktopAnalyticsFixtures.memory(days).days == days)
    }
}

@MainActor @Test func nativeHistoryAndAnalyticsLayouts() async throws {
    NSApplication.shared.finishLaunching()
    let output = ProcessInfo.processInfo.environment["AUTOPOD_INSIGHTS_RENDER_DIR"]
    for width in [900.0, 1500.0] {
        for tab in ["Past pods", "Patterns"] {
            try await renderInsights(DesktopHistoryWorkspace(pods: DesktopDesignPreview.pods, openPod: { _ in }, initialTab: tab), width: width,
                path: output.map { "\($0)/history-\(tab)-\(Int(width)).png" })
        }
        try await renderInsights(workspace(nil), width: width, path: output.map { "\($0)/analytics-\(Int(width)).png" })
        for card in AnalyticsCardKind.desktopCases {
            try await renderInsights(workspace(card), width: width,
                path: output.map { "\($0)/drill-\(card.rawValue)-\(Int(width)).png" })
        }
    }
    for width in [900.0, 1500.0] {
        try await renderInsights(ModelsDrillView(load: DesktopAnalyticsFixtures.models, initialSection: "What-if simulator"), width: width,
            path: output.map { "\($0)/model-simulator-\(Int(width)).png" })
        for section in ["Network", "Worktree & audit"] {
            try await renderInsights(SafetyDrillView(load: DesktopAnalyticsFixtures.safety, verifyAuditChain: DesktopAnalyticsFixtures.verify, onSelectPod: nil, initialSection: section), width: width,
                path: output.map { "\($0)/safety-\(section)-\(Int(width)).png" })
        }
    }
    try await renderInsights(workspace(nil), width: 1500, path: output.map { "\($0)/analytics-light.png" }, appearance: .aqua)
    try await renderInsights(DesktopHistoryWorkspace(pods: DesktopDesignPreview.pods, openPod: { _ in }), width: 1500,
        path: output.map { "\($0)/history-light.png" }, appearance: .aqua)
    try await renderInsights(overview(failing: true), width: 1500, path: output.map { "\($0)/analytics-error.png" })
    try await renderInsights(DesktopHistoryWorkspace(pods: [], openPod: { _ in }, isConnected: false), width: 900,
        path: output.map { "\($0)/history-empty-offline.png" })
}

@MainActor private func workspace(_ selected: AnalyticsCardKind?) -> some View {
    DesktopAnalyticsWorkspace(selected: .constant(selected), days: .constant(30), isConnected: true,
        viewHistory: {}, overview: { _ in AnyView(overview()) }, detail: { card, _ in
            AnyView(AnalyticsRightPaneView(card: card, pods: DesktopDesignPreview.pods,
                loadCost: DesktopAnalyticsFixtures.cost, loadReliability: DesktopAnalyticsFixtures.reliability,
                loadQuality: DesktopAnalyticsFixtures.quality, loadSafety: DesktopAnalyticsFixtures.safety,
                loadThroughput: DesktopAnalyticsFixtures.throughput, loadEscalations: DesktopAnalyticsFixtures.escalations,
                loadModels: DesktopAnalyticsFixtures.models, loadMemory: DesktopAnalyticsFixtures.memory,
                verifyAuditChain: DesktopAnalyticsFixtures.verify))
        })
}

@MainActor @Test func analyticsSelectedWindowReachesOverviewAndDrillLoaders() async throws {
    NSApplication.shared.finishLaunching()
    var observed: [Int] = []
    try await renderInsights(AnalyticsView(pods: [], loadCost: { days in observed.append(days); return try DesktopAnalyticsFixtures.cost(days) },
        loadReliability: { days in observed.append(days); return try DesktopAnalyticsFixtures.reliability(days) })
        .environment(\.desktopAnalyticsWindow, 7), width: 900, path: nil)
    #expect(observed == [7, 7])
    observed = []
    for card in AnalyticsCardKind.desktopCases where card != .status {
        try await renderInsights(AnalyticsRightPaneView(card: card, pods: [],
            loadCost: { days in observed.append(days); return try DesktopAnalyticsFixtures.cost(days) },
            loadReliability: { days in observed.append(days); return try DesktopAnalyticsFixtures.reliability(days) },
            loadQuality: { days in observed.append(days); return try DesktopAnalyticsFixtures.quality(days) },
            loadSafety: { days in observed.append(days); return try DesktopAnalyticsFixtures.safety(days) },
            loadThroughput: { days in observed.append(days); return try DesktopAnalyticsFixtures.throughput(days) },
            loadEscalations: { days in observed.append(days); return try DesktopAnalyticsFixtures.escalations(days) },
            loadModels: { days in observed.append(days); return try DesktopAnalyticsFixtures.models(days) },
            loadMemory: { days in observed.append(days); return try DesktopAnalyticsFixtures.memory(days) })
            .environment(\.desktopAnalyticsWindow, 90), width: 900, path: nil)
    }
    #expect(observed == Array(repeating: 90, count: 8))
}

@MainActor private func overview(failing: Bool = false) -> some View {
    AnalyticsView(pods: DesktopDesignPreview.pods,
        loadCost: { days in if failing { throw DaemonError.badRequest("Fictional load failure") }; return try DesktopAnalyticsFixtures.cost(days) },
        loadReliability: DesktopAnalyticsFixtures.reliability, loadQualityAnalytics: DesktopAnalyticsFixtures.quality,
        loadSafetyAnalytics: DesktopAnalyticsFixtures.safety, loadThroughputAnalytics: DesktopAnalyticsFixtures.throughput,
        loadEscalationsAnalytics: DesktopAnalyticsFixtures.escalations, loadModelsAnalytics: DesktopAnalyticsFixtures.models,
        loadMemoryAnalytics: DesktopAnalyticsFixtures.memory)
}

@MainActor private func renderInsights<V: View>(_ view: V, width: Double, path: String?, appearance: NSAppearance.Name = .darkAqua) async throws {
    let height = 960.0
    let host = NSHostingView(rootView: view.environment(\.desktopRedesign, true).environment(\.desktopAnalyticsWindow, 30)
        .environment(\.colorScheme, appearance == .aqua ? .light : .dark)
        .environment(\.desktopRepositories, Dictionary(uniqueKeysWithValues: DesktopDesignPreview.pods.compactMap { pod in DesktopRepository.resolve(pod, profiles: MockProfiles.all).map { (pod.id, $0) } }))
        .environment(\.controlActiveState, .key).tint(DesktopTheme.accent).frame(width: width, height: height))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.contentView = nil; window.close() }
    window.contentView = host; host.appearance = NSAppearance(named: appearance)
    window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(200))
    window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
    #expect(host.fittingSize.width <= width)
    #expect(host.fittingSize.height <= height)
    if let path {
        try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path, withIntermediateDirectories: true)
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
    }
}
