import AppKit
import AutopodClient
@testable import AutopodUI
import SwiftUI
import Testing
@testable import AutopodDesktop

@MainActor @Test func redesignedSchedulesAndReportsFitDesktopLayouts() async throws {
  NSApplication.shared.finishLaunching()
  let fixture = DesktopScheduleFixtures()
  let output = ProcessInfo.processInfo.environment["AUTOPOD_SCHEDULE_RENDER_DIR"]
  let unavailable = DaemonError.badRequest("Offline view harness")
  let configuration = LaunchConfigurationActions(documents: DesktopConfigurationFixtures.documents,
    capabilities: .object([:]), reload: {}, resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
    save: { _, _ in throw unavailable }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] },
    discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  for width in [900.0, 1500.0] {
    try renderSchedule(
      DesktopSchedulesView(jobs: fixture.jobs, templates: fixture.templates, profiles: [], configuration: configuration,
        actions: fixture.actions, openReports: { _ in }, openPod: { _ in }),
      width: width, path: output.map { "\($0)/schedules-\(Int(width)).png" })
  }
  for width in [900.0, 1500.0] {
    try renderSchedule(DesktopSchedulesView(jobs: fixture.jobs, templates: fixture.templates, profiles: [],
      configuration: configuration, actions: fixture.actions, openReports: { _ in }, openPod: { _ in }, initialTab: "Templates"),
      width: width, path: output.map { "\($0)/templates-\(Int(width)).png" })
    for area in ["Schedule", "Launch setup", "Prompt & fields", "Advanced"] {
      try renderSchedule(DesktopScheduleEditor(job: fixture.jobs[0], templates: fixture.templates,
        profiles: [], configuration: configuration, actions: fixture.actions, initialArea: area,
        onClose: {}, onDirty: { _ in }, onBusy: { _ in }),
        width: width, path: output.map { "\($0)/editor-\(area)-\(Int(width)).png" })
    }
    try renderSchedule(ScheduledJobTemplateSheet(isPresented: .constant(true), template: fixture.templates[0],
      embedded: true, saveAwaited: { _ in }), width: width, path: output.map { "\($0)/template-editor-\(Int(width)).png" })
  }
  let api = DesktopScanFixtures()
  let page = try await api.listScanReportPage("security", before: nil)
  let detail = try await api.getScanReportReview("fixture-report")
  for section in ["Findings", "Source & scanners", "Judgment", "Decisions"] {
    for width in [900.0, 1500.0] {
      try renderSchedule(ScanInboxView(job: fixture.jobs[1], api: api, embedded: true,
        initialReports: page.items, initialDetail: detail, initialSection: section),
        width: width, path: output.map { "\($0)/report-\(section)-\(Int(width)).png" })
    }
  }
  for scenario in ["empty_delta", "incomplete", "evidence_unavailable"] {
    let scenarioAPI = DesktopScanFixtures(scenario: scenario)
    let scenarioDetail = try await scenarioAPI.getScanReportReview("fixture-report")
    try renderSchedule(ScanInboxView(job: fixture.jobs[1], api: scenarioAPI, embedded: true,
      initialReports: page.items, initialDetail: scenarioDetail), width: 1500,
      path: output.map { "\($0)/report-\(scenario).png" })
  }
  try renderSchedule(ScanInboxView(job: fixture.jobs[1], api: api, embedded: true, showPolicy: true),
    width: 1200, path: output.map { "\($0)/scan-policy.png" })
}

@MainActor private func renderSchedule<V: View>(_ view: V, width: Double, path: String?) throws {
  if let path { FileHandle.standardOutput.write(Data("Rendering \(URL(fileURLWithPath: path).lastPathComponent)\n".utf8)) }
  let height = 900.0
  let hosting = NSHostingView(rootView: view.environment(\.desktopRedesign, true)
    .environment(\.controlActiveState, .key).tint(DesktopTheme.accent).frame(width: width, height: height))
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
    styleMask: [.titled], backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  defer { window.contentView = nil; window.close() }
  window.contentView = hosting; hosting.appearance = NSAppearance(named: .darkAqua)
  window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded()
  #expect(hosting.fittingSize.width <= width)
  #expect(hosting.fittingSize.height <= height)
  if let path {
    try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path, withIntermediateDirectories: true)
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
  }
}
