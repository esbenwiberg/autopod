import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor private final class SavedDraftFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  var preparations: [SavedWorkDraftPrepare] = []
  var confirmations: [SavedWorkDraftConfirm] = []
  var observations = 0
  var loseConfirmation = false
  var state = "prepared"
  var request: SavedWorkDraftPrepare?
  let sha = String(repeating: "a", count: 40)
  let binding = String(repeating: "b", count: 64)
  var source: [String: Any] {
    ["id": "checkpoint-2", "kind": "sandbox-checkpoint", "commit": sha,
      "tree": String(repeating: "c", count: 40), "parent": String(repeating: "d", count: 40),
      "ref": "refs/autopod-quarantine/polite-tarsier/2", "capturedAt": "2026-11-16T12:00:00Z",
      "freshness": "older-saved", "exclusions": "Later sandbox edits and unsaved host/index work are excluded."]
  }
  func decode<T: Decodable>(_ object: [String: Any], as: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
  }
  func operation() throws -> SavedWorkDraftOperation {
    var object: [String: Any] = ["id": "operation", "requestId": request?.requestId ?? "saved-request",
      "podId": "polite-tarsier", "actorId": "human", "generation": 1,
      "previewBinding": binding, "confirmationBinding": binding, "repository": "https://github.com/org/repo",
      "baseBranch": "main", "branch": "autopod/saved-work/polite-tarsier/operation", "source": source,
      "checks": "Validation NOT RUN. Applicability UNKNOWN.", "body": "Draft only; original retained.",
      "createdAt": "2026-11-16T12:00:00Z", "expiresAt": "2026-11-16T12:15:00Z", "state": state]
    if state == "published" {
      object["receipt"] = ["url": "https://github.com/org/repo/pull/9", "draft": true,
        "head": sha, "baseBranch": "main", "branch": "autopod/saved-work/polite-tarsier/operation"]
    }
    return try decode(object, as: SavedWorkDraftOperation.self)
  }
  func preview() throws -> SavedWorkDraftPreview {
    try decode(["podId": "polite-tarsier", "generation": 1, "binding": binding,
      "repository": "https://github.com/org/repo", "baseBranch": "main", "sources": [source],
      "checks": "Validation NOT RUN. Applicability UNKNOWN.", "blockers": ["Latest checkpoint unavailable; select older saved work explicitly."]], as: SavedWorkDraftPreview.self)
  }
  var actions: SavedWorkDraftActions {
    SavedWorkDraftActions(scope: "fixture-human-daemon", inspect: { _ in try self.preview() },
      prepare: { _, request in self.request = request; self.preparations.append(request); return try self.operation() },
      confirm: { _, request in
        self.confirmations.append(request)
        if self.loseConfirmation { self.state = "create-uncertain"; throw URLError(.timedOut) }
        self.state = "published"; return try self.operation()
      }, observe: { _, requestId in
        self.observations += 1
        guard requestId == self.request?.requestId else { throw URLError(.badServerResponse) }
        return try self.operation()
      })
  }
  func model() -> SavedWorkDraftModel { .init(podId: "polite-tarsier", scope: actions.scope, directory: folder) }
  func clean() { try? FileManager.default.removeItem(at: folder) }
}

@MainActor @Suite(.serialized) struct SavedWorkDraftTests {
  @Test func explicitSourceAndFreshDraftOnlyConfirmation() async throws {
    let f = SavedDraftFixture(); defer { f.clean() }
    let model = f.model()
    await model.refresh(f.actions)
    #expect(f.preparations.isEmpty && f.confirmations.isEmpty && !model.canPrepare)
    model.selectedSource = "checkpoint-2"
    #expect(model.canPrepare)
    await model.prepare(f.actions)
    #expect(f.preparations.count == 1 && !model.canConfirm)
    #expect(model.operation?.source.freshness == "older-saved")
    model.acknowledgeDraftOnly = true
    #expect(model.canConfirm)
    await model.confirm(f.actions)
    #expect(f.confirmations.first?.draftOnly == true)
    #expect(model.operation?.safeDraftURL?.absoluteString == "https://github.com/org/repo/pull/9")
  }
  @Test func uncertainCreateSurvivesReopeningAndObservationNeverResubmits() async throws {
    let f = SavedDraftFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions); model.selectedSource = "checkpoint-2"
    await model.prepare(f.actions); model.acknowledgeDraftOnly = true; f.loseConfirmation = true
    await model.confirm(f.actions)
    let reopened = f.model(); await reopened.refresh(f.actions)
    reopened.acknowledgeDraftOnly = true
    #expect(reopened.needsObservation && !reopened.canConfirm)
    await reopened.confirm(f.actions); await reopened.refresh(f.actions)
    #expect(f.confirmations.count == 1 && f.preparations.count == 1 && f.observations == 2)
    #expect(reopened.operation?.safeDraftURL == nil)
  }
  @Test func changedConnectionAndUnavailableApiCannotSend() async throws {
    let f = SavedDraftFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions); model.selectedSource = "checkpoint-2"
    var changed = f.actions; changed.scope = "other-daemon"
    await model.prepare(changed); await model.prepare(.unavailable)
    #expect(f.preparations.isEmpty)
  }
  @Test func cancellationRetainsTheSourceAndAllowsAFreshExplicitSelection() async throws {
    let f = SavedDraftFixture(); defer { f.clean() }
    var actions = f.actions
    actions.cancel = { _, request in
      #expect(request.requestId == f.request?.requestId)
      f.state = "cancelled"; return try f.operation()
    }
    let model = f.model(); await model.refresh(actions); model.selectedSource = "checkpoint-2"
    await model.prepare(actions)
    #expect(model.canCancel)
    await model.cancel(actions)
    #expect(model.operation?.state == "cancelled" && f.confirmations.isEmpty)
    await model.reviewAgain(actions)
    #expect(model.pending == nil && !model.canPrepare)
    model.selectedSource = "checkpoint-2"
    #expect(model.canPrepare)
  }
  @Test(arguments: [false, true]) func failedCompromisedTaskShowsNativeActionWithoutPassingChecks(redesign: Bool) async throws {
    // Native accessibility proof must execute on a Mac.
    let pod = Pod(id: "polite-tarsier", status: .failed, hasWorktree: true, branch: "feature",
      profileName: "fixture", task: "Saved source review", model: "fixture", startedAt: .now)
    var compromised = pod; compromised.worktreeCompromised = true
    let host = LaunchComposerHost(DetailPanelView(pod: compromised, events: [], actions: PodActions()), width: 1100, redesign: redesign)
    defer { host.close() }
    try await host.wait { host.has("saved-work-draft-action") }
    #expect(host.enabled("saved-work-draft-action"))
  }
  @Test func lostUnadmittedPreparationRequiresDurableRevocationBeforeClearingJournal() async throws {
    let f = SavedDraftFixture(); defer { f.clean() }
    var actions = f.actions
    actions.prepare = { _, request in f.preparations.append(request); throw URLError(.timedOut) }
    actions.observe = { _, _ in throw DaemonError.notFound("No operation observed") }
    let model = f.model(); await model.refresh(actions); model.selectedSource = "checkpoint-2"
    await model.prepare(actions); await model.refresh(actions)
    #expect(model.pending != nil && model.canCancelPendingPreparation && !model.canPrepare)
    #expect(f.preparations.count == 1 && f.confirmations.isEmpty)
    actions.cancelPreparation = { _, _ in throw URLError(.timedOut) }
    await model.cancelPendingPreparation(actions)
    #expect(model.pending != nil && f.preparations.count == 1)
    actions.cancelPreparation = { podId, request in
      try f.decode(["podId": podId, "requestId": request.requestId, "expectedBinding": request.expectedBinding,
        "sourceId": request.sourceId, "actorId": "human", "state": "cancelled-before-publication"], as: SavedWorkDraftPreparationCancellation.self)
    }
    await model.cancelPendingPreparation(actions)
    #expect(model.pending == nil && f.preparations.count == 1)
    model.selectedSource = "checkpoint-2"
    #expect(model.canPrepare)
  }
}
