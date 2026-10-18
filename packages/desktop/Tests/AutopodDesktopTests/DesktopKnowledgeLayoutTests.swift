import AppKit
import AutopodClient
@testable import AutopodUI
@testable import AutopodDesktop
import SwiftUI
import Testing

@MainActor @Test func nativeKnowledgeWorkspaceLayouts() async throws {
    NSApplication.shared.finishLaunching()
    let output = ProcessInfo.processInfo.environment["AUTOPOD_KNOWLEDGE_RENDER_DIR"]
    for width in [900.0, 1500.0] {
        for section in ["Review", "Library", "Extraction"] {
            try await renderKnowledge(memory(section: section), width: width, output: output, name: "memory-\(section.lowercased())-\(Int(width))")
        }
        try await renderKnowledge(memory(section: "Library", detail: "Usage & impact"), width: width, output: output, name: "memory-usage-\(Int(width))")
        try await renderKnowledge(memory(section: "Library", detail: "Source evidence", warning: true), width: width, output: output, name: "memory-warning-\(Int(width))")
        let fixture = DesktopKnowledgeFixtures()
        try await renderKnowledge(DesktopManagedPodsWorkspace(pods: DesktopKnowledgeFixtures.managedPods, selection: .constant("managed-recovery-demo"), api: fixture.api, isLoading: false, error: nil, isConnected: true, refresh: {}), width: width, output: output, name: "managed-workspace-\(Int(width))")
    }
    let summary = try #require(DesktopKnowledgeFixtures.managedPods.first)
    let detail = try JSONDecoder().decode(ManagedPodDetailResponse.self, from: DesktopKnowledgeFixtures.detailData())
    for tab in ["Overview", "Validation", "Delivery", "Artifacts", "Activity"] {
        try await renderKnowledge(ManagedPodDetailView(pod: summary, initialDetail: detail, initialTab: tab), width: 900, output: output, name: "managed-\(tab.lowercased())")
    }
    let api = DesktopKnowledgeFixtures.makeAPI(), artifact = try #require(summary.artifacts.first)
    for path in ["summary.md", "report.html", "results.json", "trace.bin", "large.log"] {
        let state = KnowledgeRenderState()
        try await renderKnowledge(ManagedArtifactViewer(artifact: artifact, api: api, onClose: {}, initialPath: path, initialHTMLSource: path.hasSuffix("html"), onPreviewSettled: { state.ready = true }), width: 1500, output: output, name: "artifact-" + path.replacingOccurrences(of: ".", with: "-"), ready: { state.ready })
    }
    let integrityState = KnowledgeRenderState()
    try await renderKnowledge(ManagedArtifactViewer(artifact: artifact, api: DesktopKnowledgeFixtures.makeAPI(integrityFailure: true), onClose: {}, initialPath: "summary.md", onPreviewSettled: { integrityState.ready = true }), width: 900, output: output, name: "artifact-integrity-error", ready: { integrityState.ready })
    let failure = try #require(DesktopKnowledgeFixtures.managedPods.last)
    try await renderKnowledge(ManagedPodDetailView(pod: failure), width: 900, output: output, name: "managed-provider-failure")
    var draft = DesktopMemoryDraft(); draft.path = "/testing/setup.md"; draft.content = "Use npx pnpm install."
    try await renderKnowledge(DesktopMemoryEditor(draft: .constant(draft), original: DesktopMemoryDraft(), busy: false, error: "Save failed. Your draft is still here; retry after reconnecting.", connected: true, cancel: {}, save: {}), width: 900, output: output, name: "memory-editor-error")
    try await renderKnowledge(memory(section: "Library"), width: 1500, output: output, name: "memory-light", light: true)
    try await renderKnowledge(ManagedPodDetailView(pod: summary, initialDetail: detail), width: 900, output: output, name: "managed-light", light: true)
    try await renderKnowledge(MemoryManagementView(entries: [], error: "Could not refresh. Last loaded data is retained.", isConnected: false), width: 900, output: output, name: "memory-empty-offline")
}
@MainActor private func memory(section: String, detail: String = "Content", warning: Bool = false) -> some View {
    let fixture = DesktopKnowledgeFixtures(), id = warning ? "setup-note" : "restore-note"
    return MemoryManagementView(entries: fixture.entries, pendingCandidates: fixture.candidates, extractionAttempts: DesktopKnowledgeFixtures.attempts,
        selectedUsage: DesktopKnowledgeFixtures.usage(id), selectedStaleEvidence: warning ? DesktopKnowledgeFixtures.usage(id).filter { $0.outcome == .harmfulStale } : [], selectedMemoryDetailId: id,
        workspaceActions: fixture.actions, initialSection: section, initialDetail: detail, initialMemoryID: section == "Library" ? id : nil)
}
@MainActor private final class KnowledgeRenderState { var ready = false }
@MainActor private func renderKnowledge<V: View>(_ view: V, width: Double, output: String?, name: String, light: Bool = false, ready: (() -> Bool)? = nil) async throws {
    let height = 1000.0
    let host = NSHostingView(rootView: view.environment(\.desktopRedesign, true).environment(\.colorScheme, light ? .light : .dark)
        .environment(\.controlActiveState, .key).tint(DesktopTheme.accent).frame(width: width, height: height))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; defer { window.contentView = nil; window.close() }
    window.contentView = host; host.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
    window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
    if let ready {
        let deadline = Date().addingTimeInterval(5)
        while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(ready(), "Artifact loader must settle before capturing its visual state")
    } else { try await Task.sleep(for: .milliseconds(350)) }
    window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
    #expect(host.fittingSize.width <= width); #expect(host.fittingSize.height <= height)
    if let output {
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds)); host.cacheDisplay(in: host.bounds, to: bitmap)
        try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(output)/\(name).png"))
    }
}
