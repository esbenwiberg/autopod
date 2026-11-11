import AppKit
import AutopodClient
import SwiftUI
import Observation
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct RecoveryHubTests {
  @Test func inspectionExplainsUnknownsWithoutMutating() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = RecoveryHubModel(podId: "pod", actions: f.podActions)
    await model.refresh(pod: f.pod, actions: f.podActions)
    #expect(f.loads == 1 && f.requests.isEmpty)
    #expect(model.inspected && model.hasRetention)
    #expect(model.savedWork.contains("not been verified"))
    #expect(model.execution.contains("not been verified"))
    #expect(model.storage.contains("1 retained"))
    #expect(model.pendingRoute == nil && model.canOpen(.freeStorage))
  }

  @Test func lostStartSurvivesReopeningAndCannotBeReplayed() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let first = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await first.refresh(f.actions); first.reason = "Recover original files safely"
    let resource = try #require(first.snapshot?.resources.first)
    await first.submit(resource, action: "start", actions: f.actions)
    let saved = try #require(first.pending)
    #expect(f.requests.count == 1)
    let hub = RecoveryHubModel(podId: "pod", actions: f.podActions)
    await hub.refresh(pod: f.pod, actions: f.podActions)
    #expect(hub.sandbox.pending == saved && hub.pendingRoute == .recoverFiles)
    #expect(!hub.canOpen(.checks) && hub.canOpen(.freeStorage) && hub.canOpen(.recoverFiles))
    hub.sandbox.reason = "Editing the reason cannot create a replacement request"
    await hub.sandbox.submit(resource, action: "start", actions: f.actions)
    #expect(f.requests.count == 1)
    #expect(!hub.sandbox.canStart(resource))
  }

  @Test func unknownStartStillAllowsASeparateExplicitDiscardDecisionWithoutLosingTheStart() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions); model.reason = "Recover original files safely"
    let resource = try #require(model.snapshot?.resources.first)
    await model.submit(resource, action: "start", actions: f.actions)
    let start = try #require(model.pendingStart)
    await model.refresh(f.actions)
    model.reason = "Explicitly discard unpreserved files instead"; model.acknowledgeLoss = true
    #expect(model.canAbandon(resource) && !model.canStart(resource))
    await model.submit(resource, action: "abandon", actions: f.actions)
    let abandon = try #require(model.pendingAbandon)
    #expect(start.id != abandon.id && f.requests == [start, abandon])
    let reopened = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.pendingStart == start && reopened.pendingAbandon == abandon)
    #expect(f.requests.count == 2)
  }

  @Test func wrongReceiptAndOversizedReasonCannotClaimSuccessOrCreateANewIntent() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions)
    let resource = try #require(model.snapshot?.resources.first)
    model.reason = String(repeating: "x", count: 4001)
    await model.submit(resource, action: "start", actions: f.actions)
    #expect(f.requests.isEmpty)
    model.reason = "Recover original source files"; f.failPost = false; f.wrongReceipt = true
    await model.submit(resource, action: "start", actions: f.actions)
    #expect(model.pendingStart != nil && !model.podDeleted && model.notice == nil)
    #expect(model.error != nil && f.requests.count == 1)
  }

  @Test func rejectedStartSurvivesRestartAndNeedsFreshAbsenceBeforeExplicitDiscard() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    f.definiteRejection = true
    let first = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await first.refresh(f.actions); first.reason = "Recover original source files"
    let resource = try #require(first.snapshot?.resources.first)
    await first.submit(resource, action: "start", actions: f.actions)
    let saved = try #require(first.pendingStart)
    let reopened = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    #expect(!reopened.canDiscardRejected)
    await reopened.refresh(f.actions)
    #expect(reopened.pendingStart == saved && reopened.canDiscardRejected)
    #expect(!reopened.canStart(resource) && f.requests.count == 1)
    await reopened.discardRejected(f.actions)
    #expect(reopened.pendingStart == nil && reopened.canStart(resource))
    f.failPost = false
    await reopened.submit(resource, action: "start", actions: f.actions)
    #expect(f.requests.count == 2 && f.requests.last?.id != saved.id)
  }

  @Test(arguments: [3, 4, nil] as [Int?])
  func preservationClaimsRequireTheirOwnMatchingContextGeneration(generation: Int?) async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    var actions = f.podActions
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/repair-continuation-v1.json")
    let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    var inspectionJSON = fixtures["inspection"] as! [String: Any]
    inspectionJSON["generation"] = 3
    let inspection = try JSONDecoder().decode(RepairContinuationInspectionV1.self,
      from: JSONSerialization.data(withJSONObject: inspectionJSON))
    var repair = RepairContinuationActions(scope: "fixture", draftScope: "context", journalDirectory: f.folder,
      load: { _ in inspection }, preview: { _, _, _ in throw URLError(.unsupportedURL) },
      submit: { _, _ in Issue.record("No mutation during context inspection"); throw URLError(.unsupportedURL) },
      observe: { _, _ in throw URLError(.unsupportedURL) })
    let contextJSON: [String: Any] = ["inspection": ["generation": generation.map { $0 as Any } ?? NSNull(),
      "infrastructure": ["state": "none_recorded", "truncated": false, "needs": []],
      "prerequisites": ["sourcePreservationRecorded": true, "workerSettlementRecorded": true, "pendingDecision": false]]]
    let retained = try JSONDecoder().decode(RepairRetainedContext.self, from: JSONSerialization.data(withJSONObject: contextJSON))
    repair.context = { _ in var context = RepairContinuationContext(); context.retained = retained; return context }
    actions.repairContinuation = repair
    let hub = RecoveryHubModel(podId: "pod", actions: actions)
    await hub.refresh(pod: f.pod, actions: actions)
    #expect(hub.observationsDisagree == (generation == 4))
    #expect(hub.savedWork.contains("checkpoint is recorded") == (generation == 3))
    #expect(hub.execution.contains("Worker stop is recorded") == (generation == 3))
    hub.invalidateObservation()
    #expect(!hub.savedWork.contains("checkpoint is recorded"))
  }

  @Test func failureExplanationUsesRecordedChecksRatherThanGuessingTheCause() {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let hub = RecoveryHubModel(podId: "pod", actions: f.podActions)
    var pod = f.pod
    pod.validationChecks = ValidationChecks(smoke: true, tests: false)
    #expect(hub.failureSummary(for: pod) == "Recorded checks did not pass: tests.")
    pod.validationChecks = nil; pod.errorSummary = "Original worker stream closed; exit is unverified"
    #expect(hub.failureSummary(for: pod) == pod.errorSummary)
  }

  @Test func nativeGoalNavigationSeparatesFileRecoveryFromDeletion() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let files = RecoveryFilesTestFixture(); defer { files.clean() }; files.includeOriginal = true
    var actions = f.podActions; actions.fileRecovery = files.actions
    let model = RecoveryHubModel(podId: "pod", actions: actions)
    await model.refresh(pod: f.pod, actions: actions)
    let host = LaunchComposerHost(RecoveryHubSheet(pod: f.pod, actions: actions, model: model), width: 800)
    host.window.orderBack(nil)
    defer { host.close() }
    try await host.wait { host.has("recovery-route-recoverFiles") }
    try host.press("recovery-route-recoverFiles")
    try await host.wait { host.has("file-recovery-review-start") }
    #expect(host.enabled("file-recovery-review-start") && !host.containsText("Recovery reason"))
    #expect(!host.has("sandbox-recovery-abandon") && !host.containsText("I accept losing"))
    try host.press("recovery-hub-back")
    try await host.wait { host.has("recovery-route-freeStorage") }
    try host.press("recovery-route-freeStorage")
    try await host.wait { host.has("sandbox-recovery-abandon") }
    #expect(!host.has("sandbox-recovery-start") && host.containsText("I accept losing"))
    #expect(f.requests.isEmpty)
  }

  @Test func openRecoverySheetSurvivesSupportedLifecycleChanges() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let state = HubStatusFixture(pod: f.pod)
    let host = LaunchComposerHost(HubStatusView(fixture: state, actions: f.podActions), width: 1000)
    host.window.orderBack(nil)
    defer { host.close() }
    try await host.wait { host.has("recovery-hub-open") }
    try host.press("recovery-hub-open")
    try await host.wait { host.window.attachedSheet != nil }
    let sheet = try #require(host.window.attachedSheet)
    state.pod.status = .killed
    try await Task.sleep(for: .milliseconds(200))
    #expect(host.window.attachedSheet === sheet)
    #expect(f.requests.isEmpty)
    host.window.endSheet(sheet)
  }

  @Test func changedGenerationNeedsANewConfirmedDeletionWhileOriginalEvidenceRemains() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions); model.reason = "Discard only the original generation"; model.acknowledgeLoss = true
    let firstResource = try #require(model.snapshot?.resources.first)
    await model.submit(firstResource, action: "abandon", actions: f.actions)
    let original = try #require(model.pendingAbandon)
    f.operations = [try f.receipt(original)] // Admitted but deletion was not confirmed.
    f.generation = 4
    await model.refresh(f.actions)
    let current = try #require(model.snapshot?.resources.first)
    #expect(model.pendingAbandon == nil && !model.canAbandon(current))
    #expect(model.reason.isEmpty && !model.acknowledgeLoss)
    model.reason = "Explicitly discard the newly inspected selection"; model.acknowledgeLoss = true
    f.failPost = false
    await model.submit(current, action: "abandon", actions: f.actions)
    let successor = try #require(model.pendingAbandon)
    #expect(successor.id != original.id && successor.expectedGeneration == 4)
    #expect(f.requests == [original, successor])
    let archive = RepairContinuationJournal<SandboxRecoveryRequest>(
      scope: "stable-daemon:user\0abandon\0\(original.expectedGeneration)\0" + original.expectedResourceKey,
      podId: "pod", directory: f.folder)
    #expect(try archive.load() == original)
    let reopened = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.pendingAbandon == successor && f.requests.count == 2)
  }

  @Test func skippedDisplaySnapshotsCannotKeepLaterLifecyclesPermanentlyBlocked() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    var actions = f.podActions
    actions.stalledWorkerRecovery = StalledWorkerRecoveryActions(scope: "fixture", draftScope: "stalled", journalDirectory: f.folder,
      load: { _ in
        try JSONDecoder().decode(StalledWorkerRecoveryView.self, from: JSONSerialization.data(withJSONObject: [
          "schemaVersion": 1, "podId": "pod", "generation": f.generation, "status": "failed", "binding": String(repeating: "a", count: 64),
          "canStop": false, "blockers": [], "operation": NSNull()]))
      }, submit: { _, _ in Issue.record("No automatic stop"); throw URLError(.unsupportedURL) })
    actions.repairContinuation = RepairContinuationActions(scope: "fixture", draftScope: "repair", journalDirectory: f.folder,
      load: { _ in try hubRepairInspection(generation: f.generation) }, preview: { _, _, _ in throw URLError(.unsupportedURL) },
      submit: { _, _ in Issue.record("No automatic repair"); throw URLError(.unsupportedURL) },
      observe: { _, _ in throw URLError(.unsupportedURL) })
    let hub = RecoveryHubModel(podId: "pod", actions: actions)
    var pod = f.pod
    await hub.refresh(pod: pod, actions: actions)
    #expect(!hub.observationsDisagree && hub.stalled.snapshot?.generation == 3)
    pod.status = .validated; f.generation = 4
    await hub.refresh(pod: pod, actions: actions)
    #expect(hub.stalled.snapshot?.generation == 3 && hub.repair.snapshot?.generation == 4)
    #expect(!hub.observationsDisagree && hub.canOpen(.continueWork))
    pod.status = .killed; f.generation = 5
    await hub.refresh(pod: pod, actions: actions)
    #expect(hub.repair.snapshot?.generation == 4) // Retain historical observations, not display authority.
    #expect(!hub.observationsDisagree && hub.canOpen(.freeStorage) && f.requests.isEmpty)
  }

  @Test func abandonReconcilesExactBodyAndReportsPartialCleanup() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let first = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await first.refresh(f.actions); first.reason = "Discard only this original environment"; first.acknowledgeLoss = true
    let resource = try #require(first.snapshot?.resources.first)
    await first.submit(resource, action: "abandon", actions: f.actions)
    let saved = try #require(first.pending)
    let reopened = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.pending == saved && reopened.acknowledgeLoss)
    f.failPost = false
    reopened.reason = "This edit must not replace the saved decision"
    await reopened.submit(resource, action: "abandon", actions: f.actions)
    #expect(f.requests == [saved, saved])
    #expect(reopened.notice?.contains("cleanup is still blocked") == true)
    #expect(!reopened.podDeleted && reopened.pending == saved)
  }

  @Test func unknownWakeupAndConnectionChangeNeverEnableStart() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    f.unknownStart = true
    let model = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions); model.reason = "Recover original source files"
    let resource = try #require(model.snapshot?.resources.first)
    #expect(!model.canStart(resource))
    await model.submit(resource, action: "start", actions: f.actions)
    #expect(f.requests.isEmpty)
    f.onLoad = { f.current = false }
    await model.refresh(f.actions)
    #expect(model.snapshot == nil && model.error?.contains("Connection changed") == true)
  }

  @Test func foreignObservationAndCorruptSavedRequestFailClosed() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    f.returnedPod = "other"
    let model = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions)
    #expect(model.snapshot == nil && model.error != nil)
    f.returnedPod = "pod"
    let journal = RepairContinuationJournal<SandboxRecoveryRequest>(scope: "stable-daemon:user\0start", podId: "pod", directory: f.folder)
    try FileManager.default.createDirectory(at: f.folder, withIntermediateDirectories: true)
    try Data("bad json".utf8).write(to: journal.url)
    let reopened = SandboxRecoveryModel(podId: "pod", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.snapshot == nil && reopened.error != nil && f.requests.isEmpty)
  }

  @Test func differentLifecyclesCannotProduceARecommendedMutation() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    var actions = f.podActions
    actions.retainedFinalization = RetainedFinalizationActions(scope: "fixture", draftScope: "mixed", journalDirectory: f.folder,
      load: { _ in
        try JSONDecoder().decode(RetainedFinalizationView.self, from: Data("""
        {"podId":"pod","generation":4,"status":"failed","binding":"\(String(repeating: "a", count: 64))","custody":[],"canStop":false,"canCompleteMerged":false,"blockers":[]}
        """.utf8))
      }, submit: { _, _ in Issue.record("No mutation from overview"); throw URLError(.unsupportedURL) })
    let hub = RecoveryHubModel(podId: "pod", actions: actions)
    await hub.refresh(pod: f.pod, actions: actions)
    #expect(hub.observationsDisagree && !hub.canOpen(.continueWork) && !hub.canOpen(.freeStorage))
    #expect(hub.savedWork.contains("Changed during inspection"))
    #expect(f.requests.isEmpty)
  }

  @Test func unavailableDaemonDoesNotHideRecoveryOrInventPreservation() async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    f.loadFailure = true
    let hub = RecoveryHubModel(podId: "pod", actions: f.podActions)
    await hub.refresh(pod: f.pod, actions: f.podActions)
    #expect(!hub.errors.isEmpty && hub.savedWork.contains("not been verified"))
    #expect(hub.sandbox.snapshot == nil && f.requests.isEmpty)
  }

  @Test(arguments: ["dark-wide", "light-wide", "dark-narrow", "light-narrow", "pending", "high-contrast"], [640.0, 820.0])
  func modernRecoveryReflowsWithoutHidingConsequencesOrChangingActions(scenario: String, height: Double) async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = RecoveryHubModel(podId: "pod", actions: f.podActions)
    await model.refresh(pod: f.pod, actions: f.podActions)
    if scenario == "pending" {
      model.sandbox.reason = "Recover source from the original environment"
      await model.sandbox.submit(try #require(model.sandbox.snapshot?.resources.first), action: "start", actions: f.actions)
      await model.sandbox.refresh(f.actions)
    }
    let requestsBeforeRendering = f.requests.count
    let light = scenario.hasPrefix("light")
    let width: CGFloat = scenario.hasSuffix("narrow") ? 680 : 820
    NSApplication.shared.finishLaunching()
    let attribute = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let prior = NSApplication.shared.accessibilityAttributeValue(attribute)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: attribute)
    defer { NSApplication.shared.accessibilitySetValue(prior, forAttribute: attribute) }
    let view = NSHostingView(rootView: RecoveryHubSheet(pod: f.pod, actions: f.podActions, model: model)
      .preferredColorScheme(light ? .light : .dark))
    view.sizingOptions = []
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: width, height: height),
      styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view
    let appearance = NSAppearance(named: scenario == "high-contrast" ? .accessibilityHighContrastDarkAqua : light ? .aqua : .darkAqua)
    window.appearance = appearance; view.appearance = appearance; window.orderBack(nil)
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(180)); view.layoutSubtreeIfNeeded()
    let nodes = hubNodes(view)
    let bounds = window.convertToScreen(view.convert(view.bounds, to: nil))
    var frames: [NSRect] = []
    for route in ["continueWork", "recoverFiles", "freeStorage"] {
      let buttons = nodes.filter { hubValue($0, "accessibilityIdentifier") as? String == "recovery-route-\(route)"
        && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) }
      #expect(buttons.count == 1, "Exactly one native button per goal: \(scenario) / \(route)")
      let button = try #require(buttons.first)
      let frame = try #require(hubValue(button, "accessibilityFrame") as? NSValue).rectValue
      #expect(frame.width > 0 && frame.minX >= bounds.minX - 2 && frame.maxX <= bounds.maxX + 2)
      frames.append(frame)
      #expect(hubValue(button, "accessibilityEnabled") as? Bool == (scenario != "pending" || route != "continueWork"))
    }
    if scenario.hasSuffix("narrow") {
      #expect(abs(frames[0].midY - frames[1].midY) > 30) // One readable column, not squeezed tiles.
    } else {
      #expect(abs(frames[0].midY - frames[1].midY) < 2)
    }
    let copy = nodes.flatMap { node in
      [hubValue(node, "accessibilityLabel") as? String, hubValue(node, "accessibilityValue") as? String].compactMap { $0 }
    }.joined(separator: "\n")
    for fact in [model.savedWork, model.execution, model.storage] { #expect(copy.contains(fact)) }
    #expect(copy.contains("archive-and-release is not yet available"))
    if scenario == "pending" { #expect(copy.contains("A missing response does not prove failure")) }
    #expect(f.requests.count == requestsBeforeRendering)
    if let directory = ProcessInfo.processInfo.environment["AUTOPOD_HUB_SCREENSHOTS"] {
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      try #require(bitmap.representation(using: .png, properties: [:]))
        .write(to: URL(fileURLWithPath: directory).appendingPathComponent("modern-\(scenario)-\(Int(height)).png"))
    }
    // Font metrics and the runner's display can leave even wide cards below the
    // fold. Measure the real clip view, not a fixed clearance from the window.
    let scroll = try #require(hubScrollViews(view).first { $0.documentView != nil })
    let document = try #require(scroll.documentView)
    let viewport = window.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
    #expect(viewport.width > 0 && viewport.height > 0)
    #expect(viewport.minY > bounds.minY && viewport.maxY < bounds.maxY)
    for route in ["continueWork", "recoverFiles", "freeStorage"] {
      let button = try #require(hubGoal(route, in: view))
      let initialFrame = try #require(hubValue(button, "accessibilityFrame") as? NSValue).rectValue
      document.scrollToVisible(document.convert(window.convertFromScreen(initialFrame), from: nil))
      scroll.reflectScrolledClipView(scroll.contentView)
      for _ in 0..<50 {
        view.layoutSubtreeIfNeeded()
        if let current = hubGoal(route, in: view),
          let frame = (hubValue(current, "accessibilityFrame") as? NSValue)?.rectValue,
          viewport.insetBy(dx: -2, dy: -2).contains(frame) { break }
        try await Task.sleep(for: .milliseconds(20))
      }
      let visible = try #require(hubGoal(route, in: view))
      let frame = try #require(hubValue(visible, "accessibilityFrame") as? NSValue).rectValue
      #expect(viewport.insetBy(dx: -2, dy: -2).contains(frame),
        "Goal must scroll fully above footer/below toolbar: \(scenario), height=\(height), viewport=\(viewport), goal=\(frame), window=\(window.frame)")
    }
    // Navigation must remain actionable after real scrolling, with no dispatch.
    let storage = try #require(hubNodes(view).first {
      hubValue($0, "accessibilityIdentifier") as? String == "recovery-route-freeStorage"
        && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
    })
    _ = hubValue(storage, "accessibilityPerformPress")
    for _ in 0..<50 {
      view.layoutSubtreeIfNeeded()
      if hubNodes(view).contains(where: { hubValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-abandon" }) { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    let destinationNodes = hubNodes(view)
    #expect(destinationNodes.contains { hubValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-abandon" })
    #expect(!destinationNodes.contains { hubValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-start" })
    #expect(f.requests.count == requestsBeforeRendering)
  }

  @Test(arguments: ["card", "overview", "files", "storage"])
  func nativeSurfaceSeparatesGoalsWithoutAutomaticActions(screen: String) async throws {
    let f = RecoverySandboxFixture(); defer { f.clean() }
    let model = RecoveryHubModel(podId: "pod", actions: f.podActions)
    await model.refresh(pod: f.pod, actions: f.podActions)
    let root: AnyView
    switch screen {
    case "card": root = AnyView(RecoveryHubCard(pod: f.pod, actions: f.podActions, model: model))
    case "files": root = AnyView(SandboxRecoverySheet(podId: "pod", actions: f.actions, purpose: .files, model: model.sandbox))
    case "storage": root = AnyView(SandboxRecoverySheet(podId: "pod", actions: f.actions, purpose: .storage, model: model.sandbox))
    default: root = AnyView(RecoveryHubSheet(pod: f.pod, actions: f.podActions, model: model))
    }
    NSApplication.shared.finishLaunching()
    let attribute = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let prior = NSApplication.shared.accessibilityAttributeValue(attribute)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: attribute)
    defer { NSApplication.shared.accessibilitySetValue(prior, forAttribute: attribute) }
    let view = NSHostingView(rootView: root)
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 800, height: 740), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view; window.orderBack(nil)
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(200)); view.layoutSubtreeIfNeeded()
    let nodes = hubNodes(view)
    func identified(_ id: String) -> [NSObject] { nodes.filter { hubValue($0, "accessibilityIdentifier") as? String == id } }
    if screen == "card" {
      #expect(!identified("recovery-hub-open").isEmpty)
      for old in ["sandbox-recovery-open", "repair-continuation-open", "stalled-worker-recovery-open", "retained-finalization-open"] {
        #expect(identified(old).isEmpty)
      }
    } else if screen == "overview" {
      for route in ["continueWork", "recoverFiles", "freeStorage"] { #expect(!identified("recovery-route-\(route)").isEmpty) }
    } else {
      let visible = screen == "files" ? "sandbox-recovery-start" : "sandbox-recovery-abandon"
      let absent = screen == "files" ? "sandbox-recovery-abandon" : "sandbox-recovery-start"
      #expect(!identified(visible).isEmpty && identified(absent).isEmpty)
      #expect(identified(visible).contains { hubValue($0, "accessibilityEnabled") as? Bool == false })
    }
    #expect(f.requests.isEmpty)
    if let directory = ProcessInfo.processInfo.environment["AUTOPOD_HUB_SCREENSHOTS"] {
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      try #require(bitmap.representation(using: .png, properties: [:]))
        .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(screen).png"))
    }
  }
}

@MainActor private func hubScrollViews(_ view: NSView) -> [NSScrollView] {
  ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(hubScrollViews)
}
@MainActor private func hubGoal(_ route: String, in view: NSView) -> NSObject? {
  hubNodes(view).first { hubValue($0, "accessibilityIdentifier") as? String == "recovery-route-\(route)"
    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) }
}
@MainActor private func hubValue(_ node: NSObject, _ key: String) -> Any? {
  let getter = key == "accessibilityEnabled" ? "isAccessibilityEnabled" : key
  guard node.responds(to: NSSelectorFromString(getter)) || node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func hubNodes(_ node: NSObject) -> [NSObject] {
  [node] + (hubValue(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(hubNodes)
}

private func hubRepairInspection(generation: Int) throws -> RepairContinuationInspectionV1 {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/repair-continuation-v1.json")
  let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  var inspection = fixtures["inspection"] as! [String: Any]
  inspection["generation"] = generation
  return try JSONDecoder().decode(RepairContinuationInspectionV1.self, from: JSONSerialization.data(withJSONObject: inspection))
}

@MainActor @Observable private final class HubStatusFixture {
  var pod: Pod
  init(pod: Pod) { self.pod = pod }
}
private struct HubStatusView: View {
  let fixture: HubStatusFixture
  let actions: PodActions
  var body: some View { DetailPanelView(pod: fixture.pod, events: [], actions: actions) }
}

@MainActor private final class RecoverySandboxFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let pod = Pod(id: "pod", status: .failed, branch: "autopod/work", profileName: "fixture", model: "fixture", startedAt: .distantPast)
  var loads = 0
  var generation = 3
  var operations: [SandboxRecoveryReceipt] = []
  var requests: [SandboxRecoveryRequest] = []
  var failPost = true
  var wrongReceipt = false
  var definiteRejection = false
  var current = true
  var unknownStart = false
  var loadFailure = false
  var returnedPod = "pod"
  var onLoad: (() -> Void)?
  func clean() { try? FileManager.default.removeItem(at: folder) }
  func receipt(_ request: SandboxRecoveryRequest) throws -> SandboxRecoveryReceipt {
    try JSONDecoder().decode(SandboxRecoveryReceipt.self, from: JSONSerialization.data(withJSONObject: [
      "id": request.id, "podId": "pod", "sandboxId": request.sandboxId, "resourceKey": request.expectedResourceKey,
      "generation": request.expectedGeneration, "action": request.action, "userId": "human", "reason": request.reason,
      "createdAt": "2026-11-10T06:00:00Z", "completedAt": NSNull()]))
  }
  var podActions: PodActions { var value = PodActions.preview; value.sandboxRecovery = actions; return value }
  var actions: SandboxRecoveryActions {
    SandboxRecoveryActions(scope: "fixture", draftScope: "stable-daemon:user", journalDirectory: folder,
      isCurrent: { self.current }, load: { _ in
        self.loads += 1; self.onLoad?()
        if self.loadFailure { throw DaemonError.notFound("Old daemon") }
        let resource: [String: Any] = ["sandboxId": "original", "resourceKey": "provider/original", "providerState": "stopped",
          "observedAt": "2026-11-10T06:00:00Z", "pendingIntentIds": self.unknownStart ? ["unknown-start"] : [],
          "startBlocked": self.unknownStart ? "Original start outcome is unknown" : NSNull(), "abandonBlocked": NSNull(), "abandonment": NSNull()]
        return try JSONDecoder().decode(SandboxRecoveryState.self, from: JSONSerialization.data(withJSONObject:
          ["podId": self.returnedPod, "generation": self.generation, "currentUserId": "human", "resources": [resource],
            "operations": try self.operations.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }, "wakeups": []]))
      }, submit: { _, request in
        self.requests.append(request)
        if self.failPost {
          if self.definiteRejection { throw DaemonError.serverError(409, "Rejected before admission") }
          throw DaemonError.networkError("Response lost")
        }
        return try JSONDecoder().decode(SandboxRecoveryResult.self, from: JSONSerialization.data(withJSONObject: [
          "operation": ["id": request.id, "podId": "pod", "sandboxId": request.sandboxId,
            "resourceKey": request.expectedResourceKey, "generation": request.expectedGeneration, "action": self.wrongReceipt ? "abandon" : request.action, "userId": "human",
            "reason": request.reason, "createdAt": "2026-11-10T06:00:00Z", "completedAt": "2026-11-10T06:01:00Z"],
          "podDeleted": false, "cleanupError": "Another owner still holds task evidence"
        ]))
      })
  }
}
