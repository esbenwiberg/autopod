import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct FollowUpTests {
  @Test func frozenOriginalAndCurrentSelectionHaveDistinctContracts() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork)
    await model.refreshSource(f.actions)
    model.selection.selections = LaunchSelections(); model.selection.selections?.githubAccess = .noAccess
    model.selection.overrides = LaunchOverrides(); model.selection.overrides?.pim = []
    #expect(model.request.selections == nil && model.request.overrides == nil)
    #expect(model.request.source?.configuration == "original")
    #expect(model.request.work?["startBranch"] == .string(f.pod.branch))
    #expect(model.request.work?["baseBranch"] == .string("main"))
    model.original = false
    #expect(model.request.selections?.githubAccess == .noAccess)
    #expect(model.request.overrides?.pim == [])
    #expect(model.request.source?.configuration == "current")
    let repo = model.request.repositoryId
    await model.refreshSource(f.actions)
    #expect(model.request.repositoryId == repo && model.request.overrides?.pim == [])
  }
  @Test func fanInAndSeriesIdentitySurviveRejectedAndUncertainLaunches() async throws {
    let f = FollowUpFixture(); let model = f.model(.dependent)
    model.selection.task = "Follow the checkpoint work"
    await model.refreshSource(f.actions)
    model.parents = []; #expect(model.validation(candidates: [f.parent]) != nil)
    model.parents = [f.pod.id]; model.series = .new; model.seriesName = "Recovery"
    let seriesID = model.request.work?["seriesId"]
    await model.resolve(f.actions, candidates: [f.parent]); #expect(model.ready)
    f.rejection = true
    await model.submit(f.actions, candidates: [f.parent])
    #expect(model.pending == nil && !model.ready && model.createdID == nil)
    #expect(model.request.work?["seriesId"] == seriesID)
    f.rejection = false
    await model.resolve(f.actions, candidates: [f.parent])
    await model.submit(f.actions, candidates: [f.parent])
    let saved = try #require(model.pending)
    #expect(saved.work?["dependsOnPodIds"] == .array([.string(f.pod.id)]))
    await model.submit(f.actions, candidates: [f.parent])
    #expect(f.launches.suffix(2).allSatisfy { $0 == saved })
    #expect(model.createdID == "created-pod")
  }
  @Test func parentBecomingIneligibleBlocksSubmissionAfterPreview() async throws {
    let f = FollowUpFixture(); let model = f.model(.dependent); model.selection.task = "Follow"
    await model.refreshSource(f.actions); await model.resolve(f.actions, candidates: [f.parent])
    var killed = f.pod; killed.status = .killed
    await model.submit(f.actions, candidates: [killed])
    #expect(f.launches.isEmpty)
    model.parents.remove(f.pod.id)
    #expect(model.validation(candidates: [killed]) != nil)
  }
  @Test func draftEditsAndConfigurationReloadInvalidateReview() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork)
    await model.refreshSource(f.actions); await model.resolve(f.actions, candidates: [])
    #expect(model.ready)
    model.selection.task = "Different task"; #expect(!model.ready)
    await model.resolve(f.actions, candidates: []); #expect(model.ready)
    f.digest = String(repeating: "b", count: 64)
    await model.refreshSource(f.actions)
    #expect(!model.ready && model.request.source?.digest == String(repeating: "b", count: 64))
    #expect(model.selection.task == "Different task")
  }
  @Test func heldPreviewCannotApproveChangedOrInvalidatedDraft() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork)
    await model.refreshSource(f.actions); f.hold = true
    let resolve = Task { await model.resolve(f.actions, candidates: []) }
    while f.continuation == nil { await Task.yield() }
    model.invalidate(); f.continuation?.resume(); await resolve.value
    #expect(!model.ready)
  }
  @Test func connectionChangeCannotReplayAnOldSourceOnAnotherDaemon() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork)
    var a = f.actions; a.connectionID = "A"
    await model.refreshSource(a); await model.resolve(a, candidates: []); await model.submit(a, candidates: [])
    let saved = model.pending; #expect(saved != nil)
    var b = f.actions; b.connectionID = "B"
    await model.submit(b, candidates: []); await model.refreshSource(b)
    #expect(f.launches.count == 1 && model.pending == saved)
    #expect(model.error?.contains("Connection changed") == true)
  }
  @Test func sharedSelectionJSONCannotInjectSourceRepositoryOrWork() throws {
    let f = FollowUpFixture(); var request = ComposableLaunchRequest(repositoryId: "repo", task: "Task")
    request.source = LaunchSource(podId: f.pod.id, digest: String(repeating: "a", count: 64), configuration: "current")
    request.work = ["startBranch": .string("source")]
    for key in FollowUpSelectionJSON.managed {
      #expect(throws: (any Error).self) { try FollowUpSelectionJSON.decode("{\"\(key)\":null}", preserving: request) }
    }
    let value = try FollowUpSelectionJSON.decode(#"{"selections":{"githubAccessId":null,"toolPackIds":[]},"overrides":{"pim":[],"execution":{"main":{"memoryGb":null}}}}"#, preserving: request)
    #expect(value.source == request.source && value.work == request.work && value.repositoryId == "repo" && value.task == "Task")
    #expect(value.selections?.githubAccess == .noAccess && value.overrides?.pim == [])
    #expect(throws: (any Error).self) { try FollowUpSelectionJSON.decode(#"{"futureField":true}"#, preserving: request) }
  }
  @Test func controlResponseLossRequiresInspectionAndExplicitReview() async throws {
    let f = FollowUpFixture(); let model = PodRepairModel(kind: .prFix, scope: "A"); model.feedback = "Keep this message"
    await model.submit(id: f.pod.id, actions: f.repairs)
    #expect(model.uncertain && model.feedback == "Keep this message")
    await model.submit(id: f.pod.id, actions: f.repairs)
    #expect(f.repairsSubmitted.count == 1)
    model.reviewAnotherAttempt(); #expect(model.uncertain)
    await model.inspect(id: f.pod.id, actions: f.repairs)
    #expect(model.observation?.source.id == f.pod.id && model.receipt == nil && model.uncertain)
    model.reviewAnotherAttempt(); #expect(!model.uncertain)
    await model.submit(id: f.pod.id, actions: f.repairs)
    #expect(model.receipt?.unreadFeedback == 3 && model.feedback == "Keep this message")
    var another = f.repairs; another = PodRepairActions(scope: "B", submit: another.submit, inspect: another.inspect)
    await model.inspect(id: f.pod.id, actions: another)
    #expect(model.error?.contains("Connection changed") == true)
  }
  @Test func definiteControlRejectionRetainsFeedbackWithoutAmbiguousRetry() async throws {
    let f = FollowUpFixture(); f.rejection = true
    let model = PodRepairModel(kind: .manual); model.feedback = "Draft"
    await model.submit(id: f.pod.id, actions: f.repairs)
    #expect(!model.uncertain && model.receipt == nil && model.feedback == "Draft" && model.error != nil)
  }
  @Test func nativeComposerUsesReviewGateAndLocksExactRetry() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork)
    let host = LaunchComposerHost(FollowUpLaunchSheet(isPresented: .constant(true), kind: .fork, initiator: f.pod,
      candidatePods: [], actions: f.actions, model: model), width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("followup-preview") }
    #expect(!host.enabled("followup-submit"))
    try host.press("followup-preview"); try await host.wait { host.enabled("followup-submit") }
    try host.capture("followup-fork-review")
    try host.press("launch-stage-0"); try await host.wait { host.has("followup-task") }
    try host.edit("followup-task", text: "Changed fork task")
    try await host.wait { !host.enabled("followup-submit") }
    try host.press("followup-preview"); try await host.wait { host.enabled("followup-submit") }
    try host.press("followup-submit"); try await host.wait { host.enabled("followup-retry") }
    #expect(!host.enabled("launch-stage-0"))
    try host.capture("followup-retained-request")
    try host.press("followup-retry"); try await host.wait { model.createdID != nil }
    #expect(f.launches.count == 2 && f.launches[0] == f.launches[1])
  }
  @Test func nativeControlHandoffKeepsFeedbackAndReconcilesBeforeRepeat() async throws {
    let f = FollowUpFixture(); let model = PodRepairModel(kind: .prFix)
    var actions = PodActions(); actions.repair = f.repairs
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: f.pod, kind: .prFix,
      relatedPods: [], actions: actions, configuration: f.actions, model: model), width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("repair-submit") }
    try host.edit("repair-feedback", text: "Verify the retry boundary")
    try host.press("repair-submit"); try await host.wait { host.enabled("repair-inspect") }
    #expect(!host.has("repair-submit") && model.feedback == "Verify the retry boundary")
    try host.capture("repair-unconfirmed")
    try host.press("repair-inspect"); try await host.wait { model.observation != nil }
    #expect(!host.has("repair-submit") && f.repairsSubmitted.count == 1)
    try host.capture("repair-observed")
  }
  @Test func nativeCurrentJSONPreservesManagedContextAndBlocksUnappliedChanges() async throws {
    let f = FollowUpFixture(); let model = f.model(.fork); model.original = false
    let host = LaunchComposerHost(FollowUpLaunchSheet(isPresented: .constant(true), kind: .fork, initiator: f.pod,
      candidatePods: [], actions: f.actions, model: model), width: 1280)
    defer { host.close() }
    try await host.wait { host.enabled("followup-preview") }
    try host.press("launch-stage-1"); try await host.wait { host.has("launch-config-advanced") }
    try host.capture("followup-current-configuration")
    try host.press("launch-config-advanced"); try await host.wait { host.has("launch-advanced-json") }
    try host.edit("launch-advanced-json", text: #"{"source":null}"#)
    try host.pressLabel("Apply JSON")
    #expect(model.jsonDirty && !host.enabled("followup-preview"))
    try host.edit("launch-advanced-json", text: #"{"selections":{"githubAccessId":null,"toolPackIds":[]},"overrides":{"pim":[]}}"#)
    try host.pressLabel("Apply JSON")
    try await host.wait { !model.jsonDirty && host.enabled("followup-preview") }
    #expect(model.request.repositoryId == "repo" && model.request.source?.configuration == "current")
    #expect(model.request.work?["startBranch"] == .string(f.pod.branch))
    #expect(model.request.selections?.githubAccess == .noAccess)
    try host.capture("followup-current-json")
  }
  @Test func nativeLayoutsCoverEachHandoffAndConfigurationAtNarrowAndWideSizes() async throws {
    let f = FollowUpFixture()
    for width in [900.0, 1440.0] {
      for kind in [FollowUpLaunchKind.dependent, .fork] {
        let model = f.model(kind); model.selection.task = "Continue from the checkpoint and verify recovery"
        await model.refreshSource(f.actions)
        let host = LaunchComposerHost(FollowUpLaunchSheet(isPresented: .constant(true), kind: kind, initiator: f.pod,
          candidatePods: [f.parent], actions: f.actions, model: model), width: width)
        try await host.wait { host.has("followup-task") }
        #expect(host.hosting.fittingSize.width <= width && host.hosting.fittingSize.height <= 850)
        try host.capture("followup-\(kind)-\(Int(width))")
        try host.press("launch-stage-1"); try await host.wait { host.has("followup-configuration-source") }
        try host.capture("followup-frozen-\(kind)-\(Int(width))"); host.close()
      }
      for kind in [PodRepairKind.manual, .rework, .prFix] {
        var actions = PodActions(); actions.repair = f.repairs
        let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: f.pod, kind: kind,
          relatedPods: [], actions: actions, configuration: f.actions), width: width, light: kind == .manual)
        try await host.wait { host.has("repair-submit") }
        #expect(host.hosting.fittingSize.width <= width && host.hosting.fittingSize.height <= 850)
        try host.capture("repair-\(kind)-\(Int(width))"); host.close()
      }
    }
  }
}

@MainActor private final class FollowUpFixture {
  var digest = String(repeating: "a", count: 64)
  var losses = 1
  var rejection = false
  var hold = false
  var continuation: CheckedContinuation<Void, Never>?
  var launches: [ComposableLaunchRequest] = []
  var repairsSubmitted: [PodRepairKind] = []
  var pod: Pod {
    Pod(id: "7c2a9e18", status: .failed, hasWorktree: true, branch: "autopod/recovery-validation", profileName: "Backend delivery",
      task: "Restore checkpoint handoff", model: "Sample model", startedAt: .distantPast, baseBranch: "main",
      phase: PhaseProgress(current: 3, total: 9, description: "Checkpoint handoff"), seriesId: "recovery", seriesName: "Recovery programme")
  }
  var parent: Pod { var value = pod; value.status = .validated; return value }
  func model(_ kind: FollowUpLaunchKind) -> FollowUpLaunchModel {
    var source = pod; source.status = .validated
    return FollowUpLaunchModel(kind: kind, initiator: source)
  }
  func snapshot() throws -> EffectiveLaunchPreview {
    try JSONDecoder().decode(EffectiveLaunchPreview.self, from: Data(ConfigurationJSON.object([
      "digest": .string(digest), "repository": .object(["id": .string("repo"), "config": .object(["remote": .string("https://github.com/acme/autopod")]), "setup": .object(["id": .string("node")])]),
      "profileId": .string("backend"), "intent": .string("task"), "work": .object(["prMode": .string("single")]),
      "ai": .object(["main": .object(["model": .string("Sample model"), "runtime": .string("codex")])]),
      "environment": .object(["name": .string("Node workspace"), "sidecars": .array([])]),
      "githubAccess": .object(["name": .string("Repository read")]), "toolPacks": .array([]), "pim": .array([]), "referenceRepositories": .array([]), "requiredSidecarIds": .array([]),
      "workflow": .object(["agentMode": .string("auto"), "output": .string("pr"), "completion": .string("approval")]),
      "resolvedExecution": .object(["target": .string("local"), "main": .object(["memoryGb": .number(8), "cpus": .number(2)])])
    ]).formatted().utf8))
  }
  var documents: [ConfigurationDocument] {
    let entries: [(ConfigurationKind, String, String, [String: ConfigurationJSON])] = [
      (.repository, "repo", "acme/autopod", ["usualProfileId": .string("backend")]),
      (.profile, "backend", "Backend delivery", ["aiId": .string("worker"), "environmentId": .string("node"), "workflowId": .string("delivery"), "execution": .object(["target": .string("local"), "main": .object(["memoryGb": .number(8)])])]),
      (.ai, "worker", "Delivery worker", ["main": .object(["model": .string("Sample model"), "runtime": .string("codex"), "providerAccountId": .string("sample-account")])]),
      (.environment, "node", "Node workspace", [:]),
      (.workflow, "delivery", "Human-reviewed delivery", ["output": .string("pr"), "completion": .string("approval")])
    ]
    return entries.map { kind, id, name, payload in
      try! JSONDecoder().decode(ConfigurationDocument.self, from: Data(ConfigurationJSON.object([
        "kind": .string(kind.rawValue), "id": .string(id), "name": .string(name), "payload": .object(payload),
        "revision": .number(1), "createdAt": .string("created"), "updatedAt": .string("updated"), "archived": .bool(false)
      ]).formatted().utf8))
    }
  }
  var actions: LaunchConfigurationActions {
    let unavailable = DaemonError.badRequest("Fixture action unavailable")
    return LaunchConfigurationActions(documents: documents, capabilities: .object(["launchAvailable": .bool(true)]), reload: {},
      resolve: { _ in if self.hold { await withCheckedContinuation { self.continuation = $0 } }; return try self.snapshot() },
      launch: { value in self.launches.append(value); if self.rejection { throw DaemonError.badRequest("Source changed") }; if self.losses > 0 { self.losses -= 1; throw DaemonError.networkError("Response lost") }; return "created-pod" },
      save: { _, _ in throw unavailable }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable }, readLaunch: { _ in try self.snapshot() })
  }
  var repairs: PodRepairActions {
    PodRepairActions(scope: "A", submit: { _, kind, _ in
      self.repairsSubmitted.append(kind)
      if self.rejection { throw DaemonError.badRequest("Terminal parent") }
      if self.repairsSubmitted.count == 1 { throw DaemonError.networkError("Response lost") }
      return PodRepairReceipt(message: "Feedback accepted", unreadFeedback: 3)
    }, inspect: { _ in PodRepairObservation(source: self.pod, related: []) })
  }
}
