import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct RecoveryForkTests {
  @Test func ordinaryRunningHubDoesNotInspectSourcesUntilExplicitRecoveryIsOpened() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    var actions = PodActions.preview; actions.recoveryFork = f.actions
    let pod = Pod(id: "original", status: .running, branch: "autopod/original", profileName: "fixture", model: "fixture", startedAt: .distantPast)
    let hub = RecoveryHubModel(podId: "original", actions: actions)
    await hub.refresh(pod: pod, actions: actions)
    #expect(f.inspections == 0 && f.created.isEmpty)
    await hub.fork.refresh(f.actions)
    #expect(f.inspections == 1 && f.created.isEmpty)
  }
  @Test func reviewIsReadOnlyAndOneConfirmedDecisionCreatesSeparateChildWithBoundHandoff() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await model.refresh(f.actions)
    #expect(f.created.isEmpty && model.selectedPaths.isEmpty && !model.canPreview)
    model.instructions = "Use the saved work. Fix Node compatibility; do not redo completed changes."
    model.acknowledged = true; model.profileId = "recovery-node"
    model.select("notes.md", selected: true)
    await model.review(f.actions)
    #expect(model.canCreate && f.created.isEmpty && f.previews.count == 1)
    #expect(model.preview?.context.messages.first?.role == "human")
    await model.create(f.actions)
    #expect(f.created.count == 1 && model.operation?.childPodId == "new-child")
    #expect(model.operation?.request.executionProfileId == "recovery-node")
    #expect(model.operation?.copiedFiles == ["notes.md"])
    #expect(model.operation?.request.instructions.contains("do not redo") == true)
    #expect(model.operation?.parentPodId == "original" && model.operation?.state == .queued)
    #expect(await model.open(f.actions)); #expect(f.opened == ["new-child"])
    await model.create(f.actions)
    #expect(f.created.count == 1)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    #expect(reopened.pending == f.created.first)
    await reopened.refresh(f.actions)
    #expect(reopened.operation == model.operation && !reopened.canCreate)
  }
  @Test func unknownLostResponseSurvivesReopenAndNeverPostsAgainEvenWhenObservationIs404() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    f.loseResponse = true; f.failObservation = true
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); await model.create(f.actions)
    #expect(model.pending != nil && model.operation == nil && !model.canDiscardRejected)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    f.observed = nil; f.failObservation = false
    await reopened.observe(f.actions)
    #expect(reopened.operation == nil && !reopened.canDiscardRejected && reopened.needsObservation)
    await reopened.create(f.actions)
    #expect(f.created.count == 1)
    f.observed = try f.operation(f.created[0]); await reopened.observe(f.actions)
    #expect(reopened.operation?.childPodId == "new-child" && f.created.count == 1)
  }
  @Test func definiteRejectionRequiresPersistedExactEvidenceAndFreshAbsenceBeforeNewReview() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    f.reject = true
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); await model.create(f.actions)
    #expect(model.canDiscardRejected)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    #expect(!reopened.canDiscardRejected)
    await reopened.observe(f.actions)
    #expect(reopened.canDiscardRejected)
    await reopened.discardRejected(f.actions)
    #expect(reopened.pending == nil && f.created.count == 1 && reopened.operation == nil)
  }
  @Test(arguments: [400, 404, 409]) func genericPostErrorAndFresh404NeverReleaseAnUncertainRequest(code: Int) async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }; f.genericCode = code
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); await model.create(f.actions)
    #expect(model.pending != nil && !model.canDiscardRejected && model.needsObservation)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    await reopened.observe(f.actions); await reopened.discardRejected(f.actions); await reopened.create(f.actions)
    #expect(reopened.pending == model.pending && !reopened.canDiscardRejected && f.created.count == 1)
  }
  @Test func discoveredUnknownOperationIsPersistedAndExactlyBoundBeforeItCanBeObserved() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    let input = RecoveryForkInput(expectedGeneration: 3, sourceHead: f.head, executionProfileId: "@original", instructions: "Continue the already reviewed checkpoint.", files: [], acknowledgePartialSource: true)
    let request = RecoveryForkRequest(expectedBinding: String(repeating: "e", count: 64), input: input)
    var operation = try f.operation(request); operation.state = .unknown; operation.childPodId = nil
    f.observed = operation
    let model = RecoveryForkModel(podId: "original", actions: f.actions); await model.refresh(f.actions)
    #expect(model.pending == request && model.needsObservation && f.created.isEmpty)
    var actions = PodActions.preview; actions.recoveryFork = f.actions
    let pod = Pod(id: "original", status: .failed, branch: "autopod/original", profileName: "fixture", model: "fixture", startedAt: .distantPast)
    let hub = RecoveryHubModel(podId: "original", actions: actions); await hub.refresh(pod: pod, actions: actions)
    #expect(hub.pendingRoute == .freshPod && !hub.canOpen(.freeStorage) && !hub.canOpen(.checks))
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    #expect(reopened.pending == request && reopened.needsObservation)
    var mismatched = operation; mismatched.request = RecoveryForkRequest(expectedBinding: String(repeating: "d", count: 64), input: input)
    f.observed = mismatched; await reopened.observe(f.actions)
    #expect(reopened.operation == nil && reopened.pending == request && reopened.error != nil)
  }
  @Test func reopenedUnconfirmedDecisionNeverLabelsNewCurrentContextAsTheSavedHandoff() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }; f.genericCode = 404
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); await model.create(f.actions)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.inspection?.context.messages.isEmpty == false && reopened.context == nil)
  }
  @Test func excessiveAdditionalBytesExplainWhyReviewIsBlocked() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    f.fileRows = (0..<11).map { ["path": "notes-\($0).md", "size": 5 * 1024 * 1024, "version": String(repeating: "c", count: 64)] }
    let model = RecoveryForkModel(podId: "original", actions: f.actions); await f.ready(model)
    for row in f.fileRows { model.select(row["path"] as! String, selected: true) }
    #expect(model.selectedBytes == 55 * 1024 * 1024 && !model.canPreview)
    #expect(model.selectionIssue?.contains("50 MiB") == true)
  }
  @Test func changedDraftSourceOrConnectionCannotReusePreview() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); #expect(model.canCreate)
    model.instructions += " Different next step."
    #expect(!model.canCreate)
    await model.review(f.actions); model.select("notes.md", selected: true)
    #expect(!model.canCreate)
    await model.review(f.actions); #expect(model.canCreate)
    f.head = String(repeating: "e", count: 40)
    await model.refresh(f.actions)
    #expect(model.preview == nil && model.selectedPaths.isEmpty)
    await model.review(f.actions); f.current = false
    await model.create(f.actions)
    #expect(f.created.isEmpty && model.inspection == nil)
  }
  @Test func invalidJournalOrMismatchedReceiptNeverCreatesAnotherChild() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    f.corruptReceipt = true
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model); await model.create(f.actions)
    #expect(model.pending != nil && model.operation == nil && !model.canCreate)
    let files = try FileManager.default.contentsOfDirectory(at: f.directory, includingPropertiesForKeys: nil)
    let decision = try #require(files.first)
    try Data("corrupt".utf8).write(to: decision)
    let reopened = RecoveryForkModel(podId: "original", actions: f.actions)
    await reopened.refresh(f.actions); await reopened.create(f.actions)
    #expect(reopened.invalidJournal && f.created.count == 1 && !reopened.canCreate)
  }
  @Test func nativeReviewAndConfirmationDispatchOnlyAfterExplicitFinalPress() async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    let model = RecoveryForkModel(podId: "original", actions: f.actions); await f.ready(model)
    NSApplication.shared.finishLaunching()
    let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let prior = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    defer { NSApplication.shared.accessibilitySetValue(prior, forAttribute: enhanced) }
    let view = NSHostingView(rootView: RecoveryForkView(actions: f.actions, model: model).padding(24)
      .background(DesktopTheme.canvas).frame(width: 680))
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 680, height: 820), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view; window.orderBack(nil)
    defer { if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }; window.close() }
    try await Task.sleep(for: .milliseconds(150))
    let create = try #require(forkNodes(view).first { forkAX($0, "accessibilityIdentifier") as? String == "recovery-fork-create" && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
    #expect(f.created.isEmpty && forkAX(create, "accessibilityEnabled") as? Bool == true)
    _ = forkAX(create, "accessibilityPerformPress")
    var confirm: NSObject?
    for _ in 0..<50 {
      let windows = [window] + (window.childWindows ?? []) + [window.attachedSheet].compactMap { $0 }
      confirm = windows.flatMap(forkNodes).first { forkAX($0, "accessibilityLabel") as? String == "Continue in fresh pod" && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) }
      if confirm != nil { break }; try await Task.sleep(for: .milliseconds(20))
    }
    let button = try #require(confirm)
    #expect(f.created.isEmpty && model.pending == nil)
    _ = forkAX(button, "accessibilityPerformPress")
    for _ in 0..<50 { if !f.created.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
    #expect(f.created.count == 1 && model.operation?.childPodId == "new-child")
  }
  @Test(arguments: [680, 820]) func nativeLightAndDarkViewsShowCheckpointAndRequireReviewWithoutDispatch(width: Int) async throws {
    let f = RecoveryForkFixture(); defer { f.clean() }
    let model = RecoveryForkModel(podId: "original", actions: f.actions)
    await f.ready(model)
    NSApplication.shared.finishLaunching()
    let view = NSHostingView(rootView: RecoveryForkView(actions: f.actions, model: model).padding(24)
      .background(DesktopTheme.canvas).tint(DesktopTheme.accent)
      .preferredColorScheme(width == 680 ? .dark : .light).frame(width: CGFloat(width)))
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: width, height: 820), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.appearance = NSAppearance(named: width == 680 ? .darkAqua : .aqua)
    view.appearance = window.appearance; window.contentView = view; window.orderBack(nil)
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(150)); view.layoutSubtreeIfNeeded()
    #expect(view.fittingSize.width == CGFloat(width))
    #expect(view.bounds.width == CGFloat(width))
    #expect(f.created.isEmpty && model.canCreate)
    if let folder = ProcessInfo.processInfo.environment["AUTOPOD_FORK_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let data = try #require(bitmap.representation(using: .png, properties: [:]))
      try data.write(to: URL(fileURLWithPath: folder).appendingPathComponent("review-\(width).png"))
    }
  }
}

@MainActor private func forkAX(_ node: NSObject, _ key: String) -> Any? {
  let getter = key == "accessibilityEnabled" ? "isAccessibilityEnabled" : key
  guard node.responds(to: NSSelectorFromString(getter)) || node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func forkNodes(_ node: NSObject) -> [NSObject] {
  [node] + (forkAX(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(forkNodes)
}

@MainActor private final class RecoveryForkFixture {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recovery-fork-tests-\(UUID().uuidString)")
  var inspections = 0
  var created: [RecoveryForkRequest] = []; var previews: [RecoveryForkInput] = []; var opened: [String] = []
  var fileRows: [[String: Any]] = [["path": "notes.md", "size": 12, "version": String(repeating: "c", count: 64)]]
  var genericCode: Int?
  var current = true; var loseResponse = false; var failObservation = false; var reject = false; var corruptReceipt = false
  var observed: RecoveryForkOperation?
  var head = String(repeating: "a", count: 40)
  var context: [String: Any] { ["summary": "Continue the existing task.", "failure": "Node compatibility check failed.", "messages": [["role": "human", "text": "Keep the working changes; fix the environment failure.", "timestamp": "2026-11-10T10:00:00Z", "eventId": 7]], "truncated": false, "omissions": ["Tool payloads and provider sessions excluded."]] }
  var source: [String: Any] { ["head": head, "tree": String(repeating: "b", count: 40), "baseCommitSha": String(repeating: "d", count: 40), "branch": "autopod/original", "repository": "https://example.com/repo.git", "files": fileRows, "truncated": false, "skippedEntries": 2, "caveats": ["Host checkpoint only. Unsaved sandbox files are unverified."]] }
  var budget: [String: Any] { ["taskId": "same-logical-task", "status": "below_recorded_limit", "tokenBudget": 10000, "recordedTokens": 2000, "retryAuthorizationRequired": false] }
  func decode<T: Decodable>(_ value: [String: Any]) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }
  func wire(_ value: some Encodable) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
  func operation(_ request: RecoveryForkRequest) throws -> RecoveryForkOperation {
    try decode(["version": 1, "id": request.id, "parentPodId": "original", "generation": 3, "actorId": "human", "request": wire(request), "state": "queued", "childPodId": "new-child", "childStatus": "queued", "sourceHead": corruptReceipt ? String(repeating: "f", count: 40) : request.sourceHead, "copiedFiles": request.files.map(\.path), "context": context, "error": NSNull(), "createdAt": "2026-11-10T10:01:00Z"])
  }
  var actions: RecoveryForkActions {
    RecoveryForkActions(scope: "fixture", journalDirectory: directory, isCurrent: { self.current }, inspect: { _ in
      self.inspections += 1
      return try self.decode(["version": 1, "podId": "original", "generation": 3, "available": self.observed == nil, "blockers": [], "source": self.source, "context": self.context, "budget": self.budget, "profiles": [["id": "@original", "label": "Original frozen environment"], ["id": "recovery-node", "label": "Recovery Node"]], "operation": self.observed.map { try! self.wire($0) } ?? NSNull(), "lineage": NSNull()])
    }, preview: { _, input in
      self.previews.append(input)
      return try self.decode(["version": 1, "podId": "original", "generation": 3, "available": true, "blockers": [], "expectedBinding": String(repeating: "e", count: 64), "source": self.source, "context": self.context, "budget": self.budget, "execution": ["profileId": input.executionProfileId, "target": "local", "template": "node-22", "platform": "linux/amd64", "memoryGb": 4, "cpus": 2, "originalTemplate": "node-20", "sameEnvironment": false], "input": self.wire(input)])
    }, create: { _, request in
      self.created.append(request)
      if self.reject { throw RecoveryForkRejection(podId: "original", request: request, message: "Selection changed before admission.") }
      if let code = self.genericCode {
        if code == 404 { throw DaemonError.notFound("No operation") }
        if code == 400 { throw DaemonError.badRequest("Generic rejection without proof") }
        throw DaemonError.serverError(code, "No request-correlated pre-claim proof")
      }
      self.observed = try self.operation(request)
      if self.loseResponse { throw URLError(.networkConnectionLost) }
      return self.observed!
    }, observe: { _, _ in
      if self.failObservation { throw URLError(.networkConnectionLost) }
      guard let observed = self.observed else { throw DaemonError.notFound("No operation") }
      return observed
    }, openPod: { self.opened.append($0) })
  }
  func ready(_ model: RecoveryForkModel) async {
    await model.refresh(actions); model.instructions = "Fix Node compatibility and continue from the checkpoint."; model.acknowledged = true; model.profileId = "recovery-node"
    await model.review(actions)
  }
  func clean() { try? FileManager.default.removeItem(at: directory) }
}
