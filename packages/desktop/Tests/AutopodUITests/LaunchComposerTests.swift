import AppKit
import AutopodClient
import SwiftUI
import Observation
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct LaunchComposerTests {
  @Test(arguments: [false, true]) func newPodSheetUsesTheMainWindowInterface(redesign: Bool) async throws {
    NSApplication.shared.finishLaunching()
    let fixture = LaunchComposerFixture()
    let suite = "autopod-launch-routing-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: suite))
    defaults.set(redesign, forKey: "autopod.desktop.redesign")
    defer { defaults.removePersistentDomain(forName: suite) }
    // Match the installed app: MainView owns the setting; its parent does not inject it.
    let host = LaunchComposerHost(MainView(pods: [], configurationActions: fixture.actions)
      .defaultAppStorage(defaults), width: 1280, redesign: false)
    defer { host.close() }
    let buttonTitle = redesign ? "New pod" : "New Pod"
    try await host.wait { host.containsText(buttonTitle) }
    try host.pressLabel(buttonTitle)
    try await host.wait { host.window.attachedSheet != nil }
    let sheet = try #require(host.window.attachedSheet)
    func sheetNodes() -> [NSObject] {
      sheet.layoutIfNeeded(); sheet.contentView?.layoutSubtreeIfNeeded()
      return sheet.contentView.map { launchNodes($0) } ?? []
    }
    func hasComposer() -> Bool {
      sheetNodes().contains { launchAX($0, "accessibilityIdentifier") as? String == "launch-stage-0" }
    }
    try await host.wait {
      hasComposer() || sheetNodes().contains { launchAX($0, "accessibilityLabel") as? String == "Full launch configuration" }
    }
    #expect(hasComposer() == redesign)
    if let output = ProcessInfo.processInfo.environment["AUTOPOD_LAUNCH_RENDER_DIR"], let view = sheet.contentView {
      try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      try #require(bitmap.representation(using: .png, properties: [:]))
        .write(to: URL(fileURLWithPath: "\(output)/main-window-new-pod-\(redesign ? "redesign" : "legacy").png"))
    }
    host.window.endSheet(sheet)
  }

  @Test func fullJSONRetainsNullEmptyAndStructuredFieldsAndRejectsLossyEdits() throws {
    let text = #"{"repositoryId":"repo","task":"Restore","work":{"kind":"task","nested":{"facts":["A"]}},"selections":{"githubAccessId":null,"toolPackIds":[]},"overrides":{"execution":{"main":{"memoryGb":null}},"pim":[]},"referenceRepositories":[{"repositoryId":"reference","ref":"spec/recovery","access":"read"}]}"#
    let request = try LaunchComposerJSON.decode(text, selectionOnly: false, task: "unused")
    let original = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(text.utf8))
    #expect(LaunchComposerJSON.value(request) == original)
    #expect(request.selections?.githubAccess == .noAccess)
    #expect(request.selections?.toolPackIds == [])
    #expect(request.overrides?.execution?["main"]?["memoryGb"] == .null)
    #expect(throws: (any Error).self) { try LaunchComposerJSON.decode(#"{"task":"A","futureField":true}"#, selectionOnly: false, task: "") }
    #expect(throws: (any Error).self) { try LaunchComposerJSON.decode(#"{"task":"A","referenceRepositories":[{"repositoryId":"r","ref":"main","access":"read","futureField":true}]}"#, selectionOnly: false, task: "") }
    for key in ["task", "work", "requestId", "expectedDigest", "origin"] {
      #expect(throws: (any Error).self) { try LaunchComposerJSON.decode("{\"\(key)\":\"unexpected\"}", selectionOnly: true, task: "Series") }
    }
    let selection = LaunchComposerJSON.value(request, selectionOnly: true)
    let roundtrip = try LaunchComposerJSON.decode(selection.formatted(), selectionOnly: true, task: "Series")
    #expect(LaunchComposerJSON.value(roundtrip, selectionOnly: true) == selection)
    #expect(roundtrip.task == "Series")
  }

  @Test func seriesReviewIncludesContractsSourceDeliveryAndSelectionButNotSubmissionID() throws {
    let fixture = LaunchComposerFixture()
    var request = fixture.seriesRequest
    let review = SeriesLaunchReview(payload: SeriesLaunchReview.fingerprint(request), configuration: try fixture.preview(fixture.request))
    request.requestId = "different-id"; #expect(review.matches(request))
    request.baseBranch = "release"; #expect(!review.matches(request)); request = fixture.seriesRequest
    request.specContextFiles = [SpecFilePayload(path: "purpose.md", content: "Changed")]; #expect(!review.matches(request)); request = fixture.seriesRequest
    request.briefs[0] = ParsedBriefResponse(title: "Restore", task: "Changed task", dependsOn: []); #expect(!review.matches(request)); request = fixture.seriesRequest
    request.launch["selections"] = .object(["githubAccessId": .null]); #expect(!review.matches(request)); request = fixture.seriesRequest
    request.prMode = "stacked"; #expect(!review.matches(request))
  }

  @Test func draftSummaryMergesPartialOverridesAndKeepsAccessSemantics() throws {
    let fixture = LaunchComposerFixture()
    var request = fixture.request
    request.overrides = LaunchOverrides(); request.overrides?.execution = ["main": .object(["cpus": .number(3)])]
    request.selections = LaunchSelections(); request.selections?.githubAccess = .noAccess; request.selections?.toolPackIds = []
    let context = LaunchComposerContext(request: request, actions: fixture.actions)
    #expect(context.details(.execution)["target"] == .string("local"))
    #expect(context.details(.execution)["main"]?["memoryGb"] == .number(8))
    #expect(context.details(.execution)["main"]?["cpus"] == .number(3))
    #expect(context.value(.github) == "No agent access")
    #expect(context.value(.tools) == "0 tool packs")
    #expect(context.origin(.github) == "Selected for this launch")
  }

  @Test func nativePodPreviewJSONGuardAndExactRetry() async throws {
    let fixture = LaunchComposerFixture()
    var createdIDs: [String] = []
    let view = ComposableCreatePodSheet(isPresented: fixture.presentation, actions: fixture.actions, initialRequest: fixture.request,
      onCreated: { createdIDs.append($0) })
    let host = LaunchComposerHost(view, width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("launch-preview") }
    try host.press("launch-preview")
    try await host.wait { host.enabled("launch-submit") }
    #expect(fixture.resolutions.count == 1)
    try host.capture("pod-review")
    try host.press("launch-stage-1")
    try await host.wait { host.has("launch-config-advanced") }
    try host.press("launch-config-advanced")
    try await host.wait { host.has("launch-advanced-json") }
    let edited = #"{"repositoryId":"repo","task":"Edited task","selections":{"githubAccessId":null,"toolPackIds":[]},"referenceRepositories":[{"repositoryId":"reference","ref":"main","access":"read"}]}"#
    try host.edit("launch-advanced-json", text: edited)
    try await host.wait { !host.enabled("launch-submit") && !host.enabled("launch-preview") }
    try host.capture("pod-unapplied-json")
    try host.pressLabel("Apply JSON")
    try await host.wait { host.enabled("launch-preview") }
    try host.press("launch-preview")
    try await host.wait { host.enabled("launch-submit") }
    #expect(fixture.resolutions.last?.task == "Edited task")
    #expect(fixture.resolutions.last?.selections?.githubAccess == .noAccess)
    #expect(fixture.resolutions.last?.referenceRepositories?.first?.repositoryId == "reference")
    try host.press("launch-submit")
    try await host.wait { host.enabled("launch-retry") }
    #expect(fixture.launches.count == 1)
    #expect(createdIDs.isEmpty, "An unconfirmed launch must not navigate away")
    #expect(!host.enabled("launch-stage-0"))
    #expect(fixture.launches[0].expectedDigest == String(repeating: "a", count: 64))
    try host.capture("pod-retained-request")
    try host.press("launch-retry")
    try await host.wait { fixture.dismissed }
    #expect(fixture.launches.count == 2)
    #expect(createdIDs == ["created-pod"], "Navigate only after the retained launch is confirmed")
    #expect(fixture.launches[0] == fixture.launches[1])
    #expect(fixture.launches[0].requestId?.isEmpty == false)
  }

  @Test func nativeSeriesReviewInheritsSidecarsAndRetryRetainsCompletePayload() async throws {
    let fixture = LaunchComposerFixture()
    let view = CreateSeriesSheet(isPresented: fixture.presentation, actions: fixture.podActions, configurationActions: fixture.actions,
      parsed: try fixture.parsed(), selection: fixture.selection)
    let host = LaunchComposerHost(view, width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("series-preview") }
    #expect(!host.enabled("series-submit"))
    try host.press("series-preview")
    try await host.wait { host.enabled("series-submit") }
    #expect(fixture.resolutions.count == 3)
    #expect(fixture.resolutions[1].requiredSidecarIds == ["database"])
    #expect(fixture.resolutions[2].requiredSidecarIds == ["cache", "database"])
    try host.capture("series-review")
    try host.press("series-submit")
    try await host.wait { host.enabled("series-retry") }
    try host.capture("series-retained-request")
    #expect(!host.enabled("launch-stage-0"))
    try host.press("series-retry")
    try await host.wait { fixture.dismissed }
    #expect(fixture.seriesLaunches.count == 2)
    #expect(LaunchComposerJSON.value(fixture.seriesLaunches[0]) == LaunchComposerJSON.value(fixture.seriesLaunches[1]))
    #expect(fixture.seriesLaunches[0].briefs[1].requireSidecars == ["cache"])
    #expect(fixture.seriesLaunches[0].specContextFiles?.first?.content == "Original spec")
  }

  @Test func nativeSeriesSourceEditsInvalidateThePlanAndReview() async throws {
    let fixture = LaunchComposerFixture()
    let host = LaunchComposerHost(CreateSeriesSheet(isPresented: .constant(true), actions: fixture.podActions,
      configurationActions: fixture.actions, parsed: try fixture.parsed(), selection: fixture.selection), width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("series-preview") }
    try host.press("series-preview"); try await host.wait { host.enabled("series-submit") }
    try host.press("launch-stage-0"); try await host.wait { host.has("series-source-folder") }
    try host.editField(placeholder: "/path/to/briefs", text: "/workspace/changed-source")
    try await host.wait { !host.enabled("series-preview") && !host.enabled("series-submit") }
    #expect(fixture.seriesLaunches.isEmpty)
    try host.capture("series-source-invalidated")
  }

  @Test func nativeGoalIsLockedAndPreviewFailureRetainsDraft() async throws {
    let fixture = LaunchComposerFixture(); fixture.resolveFailure = true
    let host = LaunchComposerHost(ComposableCreatePodSheet(isPresented: .constant(true), actions: fixture.actions, initialRequest: fixture.request), width: 900)
    defer { host.close() }
    try await host.wait { host.enabled("launch-preview") }
    #expect(!host.enabled("launch-intent-goal"))
    try host.press("launch-preview")
    try await host.wait { fixture.resolutions.count == 1 && host.enabled("launch-preview") }
    #expect(!host.enabled("launch-submit"))
    #expect(fixture.resolutions[0] == fixture.request)
    try host.capture("pod-preview-error")
    fixture.resolveFailure = false
    try host.press("launch-preview"); try await host.wait { host.enabled("launch-submit") }
    #expect(fixture.resolutions.count == 2)
    #expect(fixture.resolutions[0] == fixture.resolutions[1])
  }

  @Test(arguments: [false, true], ["local", "sandbox"])
  func nativeGoalUsesAcceptedAccountAndInheritedRoute(partialOverride: Bool, target: String) async throws {
    let fixture = LaunchComposerFixture()
    var actions = fixture.actions
    var capabilities = actions.capabilities.object ?? [:]
    capabilities["nativeGoals"] = .array([.object([
      "runtime": .string("codex"), "accountId": .string("sample-account"),
      "backend": .string(target), "available": .bool(true)
    ])])
    actions.capabilities = .object(capabilities)
    actions.launch = { value in fixture.launches.append(value); return "native-goal-fixture" }
    var request = fixture.request
    request.overrides = LaunchOverrides()
    request.overrides?.execution = ["target": .string(target)]
    if partialOverride { request.overrides?.ai = ["main": .object(["model": .string("Another model")])] }
    let host = LaunchComposerHost(ComposableCreatePodSheet(isPresented: .constant(true), actions: actions, initialRequest: request), width: 900)
    defer { host.close() }
    try await host.wait { host.enabled("launch-preview") }
    #expect(host.enabled("launch-intent-goal"))
    guard host.enabled("launch-intent-goal") else { return }
    try host.press("launch-intent-goal")
    try host.capture("native-goal-\(target)-\(partialOverride)")
    try host.press("launch-preview")
    try await host.wait { host.enabled("launch-submit") }
    #expect(fixture.resolutions.last?.intent == "goal")
    try host.press("launch-submit")
    try await host.wait { !fixture.launches.isEmpty }
    #expect(fixture.launches[0].intent == "goal")
    #expect(fixture.launches[0].overrides?.execution?["target"]?.string == target)
    #expect(fixture.launches[0].expectedDigest == String(repeating: "a", count: 64))
  }

  @Test(arguments: [false, true]) func latePreviewCannotRestoreReviewAfterConfigurationReload(series: Bool) async throws {
    let fixture = LaunchComposerFixture(); fixture.holdResolve = true
    let host = LaunchComposerHost(ReactiveLaunchFixture(fixture: fixture, series: series), width: 1280)
    defer { host.close() }
    let previewID = series ? "series-preview" : "launch-preview", submitID = series ? "series-submit" : "launch-submit"
    try await host.wait { host.enabled(previewID) }; try host.press(previewID)
    try await host.wait { fixture.heldResolution != nil }
    try host.capture(series ? "series-resolving" : "pod-resolving")
    fixture.documentRevision = 2
    try await host.wait { host.containsText("Backend delivery · revision 2") }
    let held = fixture.heldResolution; fixture.heldResolution = nil; fixture.holdResolve = false; held?.resume()
    try await host.wait { host.enabled(previewID) }
    #expect(!host.enabled(submitID))
    try host.press(previewID); try await host.wait { host.enabled(submitID) }
  }

  @Test func nativeConfigurationCategoriesRemainReachable() async throws {
    let fixture = LaunchComposerFixture()
    let host = LaunchComposerHost(ComposableCreatePodSheet(isPresented: .constant(true), actions: fixture.actions, initialRequest: fixture.request, stage: .configure), width: 1280)
    defer { host.close() }
    for section in LaunchConfigurationSection.allCases {
      try await host.wait { host.has("launch-config-\(section.id)") }
      try host.press("launch-config-\(section.id)")
      try await host.wait { host.containsText(section.rawValue) }
      try host.capture("configuration-\(section.id)")
      try host.pressLabel("← All configuration")
    }
    #expect(fixture.resolutions.isEmpty && fixture.launches.isEmpty)
  }

  @Test func nativeLayoutsFitWideAndCompactAndBothThemes() async throws {
    let fixture = LaunchComposerFixture()
    for width in [900.0, 1440.0] {
      for stage in LaunchComposerStage.allCases {
        let view = ComposableCreatePodSheet(isPresented: .constant(true), actions: fixture.actions, initialRequest: fixture.request,
          stage: stage, preview: stage == .review ? try fixture.preview(fixture.request) : nil)
        let host = LaunchComposerHost(view, width: width)
        defer { host.close() }
        try await host.wait { host.has("launch-stage-0") }
        #expect(host.hosting.fittingSize.width <= width)
        #expect(host.hosting.fittingSize.height <= 850)
        try host.capture("pod-\(stage)-\(Int(width))")
      }
      let series = LaunchComposerHost(CreateSeriesSheet(isPresented: .constant(true), actions: fixture.podActions,
        configurationActions: fixture.actions, parsed: try fixture.parsed(), selection: fixture.selection), width: width)
      try await series.wait { series.has("series-preview") }
      try series.capture("series-compose-\(Int(width))"); series.close()
    }
    let light = LaunchComposerHost(ComposableCreatePodSheet(isPresented: .constant(true), actions: fixture.actions, initialRequest: fixture.request), width: 1280, light: true)
    defer { light.close() }
    try await light.wait { light.has("launch-stage-0") }; try light.capture("pod-light")
  }
}

@Observable @MainActor private final class LaunchComposerFixture {
  var documentRevision = 1
  var holdResolve = false
  var heldResolution: CheckedContinuation<Void, Never>?
  var resolutions: [ComposableLaunchRequest] = []
  var launches: [ComposableLaunchRequest] = []
  var seriesLaunches: [CreateSeriesRequest] = []
  var dismissed = false
  var resolveFailure = false
  var request: ComposableLaunchRequest { .init(repositoryId: "repo", task: "Restore saved work without repeating completed milestones. Preserve verified artifacts and add regression coverage.") }
  var selection: [String: ConfigurationJSON] { ["repositoryId": .string("repo")] }
  var presentation: Binding<Bool> { Binding(get: { !self.dismissed }, set: { self.dismissed = !$0 }) }
  var documents: [ConfigurationDocument] {
    [document(.repository, "repo", "acme/autopod", ["usualProfileId": .string("backend"), "setups": .array([.object(["id": .string("node"), "name": .string("Node workspace")])])]),
     document(.profile, "backend", documentRevision == 1 ? "Backend delivery" : "Backend delivery · revision \(documentRevision)", ["environmentId": .string("node"), "aiId": .string("worker"), "workflowId": .string("delivery"), "githubAccessId": .string("read"), "toolPackIds": .array([.string("tools")]), "requiredSidecarIds": .array([.string("database")]), "execution": .object(["target": .string("local"), "main": .object(["memoryGb": .number(8), "cpus": .number(2)])])]),
     document(.environment, "node", "Node workspace", ["sidecars": .array([.object(["id": .string("database"), "type": .string("postgres"), "startup": .string("always")]), .object(["id": .string("cache"), "type": .string("redis"), "startup": .string("on-demand")])])]),
     document(.ai, "worker", "Delivery worker", ["main": .object(["model": .string("Sample model"), "runtime": .string("codex"), "providerAccountId": .string("sample-account")])]),
     document(.workflow, "delivery", "Human-reviewed delivery", ["agentMode": .string("auto"), "output": .string("pr"), "completion": .string("approval")]),
     document(.githubAccess, "read", "Repository read access", [:]), document(.toolPack, "tools", "Repository tools", [:])]
  }
  private func document(_ kind: ConfigurationKind, _ id: String, _ name: String, _ payload: [String: ConfigurationJSON]) -> ConfigurationDocument {
    // All fixture data stays in memory; this never contacts a daemon or provider.
    try! JSONDecoder().decode(ConfigurationDocument.self, from: Data(ConfigurationJSON.object([
      "id": .string(id), "kind": .string(kind.rawValue), "name": .string(name), "revision": .number(Double(documentRevision)), "createdAt": .string("created"), "updatedAt": .string("updated"), "archived": .bool(false), "payload": .object(payload)
    ]).formatted().utf8))
  }
  func preview(_ request: ComposableLaunchRequest) throws -> EffectiveLaunchPreview {
    try JSONDecoder().decode(EffectiveLaunchPreview.self, from: Data(ConfigurationJSON.object([
      "digest": .string(String(repeating: "a", count: 64)), "task": .string(request.task), "intent": .string(request.intent ?? "task"),
      "workflow": .object(["agentMode": .string("auto"), "output": .string("pr"), "completion": .string("approval")]),
      "ai": .object(["main": .object(["model": .string("Sample model"), "runtime": .string("codex")])]),
      "resolvedExecution": .object(["target": .string("local"), "main": .object(["memoryGb": .number(8), "cpus": .number(2)])]),
      "requiredSidecarIds": .array((request.requiredSidecarIds ?? ["database"]).map(ConfigurationJSON.string)),
      "provenance": .object(["ai": .object(["source": .string("profile")])])
    ]).formatted().utf8))
  }
  func parsed() throws -> SeriesPreviewResponse {
    let briefs = [ParsedBriefResponse(title: "Restore checkpoint", task: "Restore saved work", dependsOn: []), ParsedBriefResponse(title: "Verify recovery", task: "Verify repeatable recovery", dependsOn: ["Restore checkpoint"], requireSidecars: ["cache"])]
    return try JSONDecoder().decode(SeriesPreviewResponse.self, from: Data(ConfigurationJSON.object([
      "seriesName": .string("Recovery programme"), "briefs": LaunchComposerJSON.value(briefs),
      "seriesDescription": .string("Restore and verify recovery"), "seriesDesign": .string("Preserve artifacts and restore the unfinished handoff."),
      "specFiles": LaunchComposerJSON.value([SpecFilePayload(path: "purpose.md", content: "Original spec")])
    ]).formatted().utf8))
  }
  var seriesRequest: CreateSeriesRequest { .init(requestId: "series-original", seriesName: "Recovery", briefs: try! parsed().briefs, launch: selection,
    startBranch: "spec/recovery", baseBranch: "main", specContextFiles: [SpecFilePayload(path: "purpose.md", content: "Original spec")], prMode: "single") }
  var actions: LaunchConfigurationActions {
    let unavailable = DaemonError.badRequest("Not part of this isolated fixture")
    return LaunchConfigurationActions(documents: documents,
      capabilities: .object(["launchAvailable": .bool(true), "execution": .array([.object(["target": .string("local"), "available": .bool(true), "sidecars": .bool(true), "maxCpus": .number(4), "maxTotalMemoryGb": .number(16), "memoryTiersGb": .array([.number(4), .number(8), .number(16)])])])]), reload: {},
      resolve: { request in self.resolutions.append(request); if self.holdResolve { await withCheckedContinuation { self.heldResolution = $0 } }; if self.resolveFailure { throw DaemonError.badRequest("Configuration changed; draft retained") }; return try self.preview(request) },
      launch: { value in self.launches.append(value); if self.launches.count == 1 { throw DaemonError.badRequest("Response lost after submission") }; return "created-pod" },
      save: { _, _ in throw unavailable }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] },
      discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  }
  var podActions: PodActions {
    var actions = PodActions()
    actions.createSeries = { value in self.seriesLaunches.append(value); return self.seriesLaunches.count == 1 ? nil : "created-series" }
    actions.lastCreatePodError = { "Response lost after submission" }
    return actions
  }
}

@MainActor private struct ReactiveLaunchFixture: View {
  let fixture: LaunchComposerFixture
  let series: Bool
  var body: some View {
    if series {
      CreateSeriesSheet(isPresented: fixture.presentation, actions: fixture.podActions, configurationActions: fixture.actions,
        parsed: try! fixture.parsed(), selection: fixture.selection)
    } else {
      ComposableCreatePodSheet(isPresented: fixture.presentation, actions: fixture.actions, initialRequest: fixture.request)
    }
  }
}

@MainActor private func launchAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) || node.responds(to: NSSelectorFromString("is" + key.prefix(1).uppercased() + key.dropFirst())) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func launchNodes(_ root: NSObject) -> [NSObject] {
  [root] + (launchAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(launchNodes)
}
@MainActor final class LaunchComposerHost {
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  init<V: View>(_ view: V, width: Double, light: Bool = false, redesign: Bool = true) {
    // Keep the native accessibility client active for this test process. Toggling it
    // off while other framework views are still tearing down affects WebKit clients.
    NSApplication.shared.accessibilitySetValue(true, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
    hosting = NSHostingView(rootView: AnyView(view.environment(\.desktopRedesign, redesign).environment(\.colorScheme, light ? .light : .dark)
      .environment(\.controlActiveState, .key).transaction { $0.disablesAnimations = true }.frame(width: width, height: 850)))
    hosting.sizingOptions = []
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 850), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    hosting.appearance = NSAppearance(named: light ? .aqua : .darkAqua); window.orderFront(nil)
  }
  func close() { window.contentView = nil; window.close() }
  var nodes: [NSObject] { window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); return launchNodes(hosting) }
  func matches(_ id: String) -> [NSObject] { nodes.filter { launchAX($0, "accessibilityIdentifier") as? String == id } }
  func containsText(_ text: String) -> Bool { nodes.contains { (launchAX($0, "accessibilityLabel") as? String ?? "").contains(text) || (launchAX($0, "accessibilityValue") as? String ?? "").contains(text) } }
  func has(_ id: String) -> Bool { !matches(id).isEmpty }
  func enabled(_ id: String) -> Bool { matches(id).contains { launchAX($0, "accessibilityEnabled") as? Bool == true } }
  func press(_ id: String) throws {
    let node = try #require(matches(id).first { $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
    #expect(launchAX(node, "accessibilityEnabled") as? Bool == true); _ = launchAX(node, "accessibilityPerformPress")
  }
  func pressLabel(_ label: String) throws {
    let node = try #require(nodes.first { launchAX($0, "accessibilityLabel") as? String == label && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
    _ = launchAX(node, "accessibilityPerformPress")
  }
  func edit(_ id: String, text: String) throws {
    let node = try #require(matches(id).first { $0.responds(to: NSSelectorFromString("setAccessibilityValue:")) })
    node.setValue(text, forKey: "accessibilityValue")
  }
  func editField(placeholder: String, text: String) throws {
    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    let field = try #require(descendants(hosting).compactMap { $0 as? NSTextField }.first { $0.placeholderString == placeholder })
    window.makeFirstResponder(field)
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
  }
  func wait(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !predicate(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
    #expect(predicate())
    try #require(predicate())
  }
  func capture(_ name: String) throws {
    guard let output = ProcessInfo.processInfo.environment["AUTOPOD_LAUNCH_RENDER_DIR"] else { return }
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
    window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded()
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)); hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(output)/\(name).png"))
  }
}
