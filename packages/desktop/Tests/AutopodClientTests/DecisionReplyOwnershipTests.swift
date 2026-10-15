import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor
private func replyHandler(_ fixture: PodStoreLifetimeFixture, api: DaemonAPI? = nil) -> ActionHandler {
  ActionHandler(api: api ?? fixture.apiA, podStore: fixture.store, profileStore: ProfileStore())
}

@MainActor
private func replyPost(_ fixture: PodStoreLifetimeFixture, decision: String = "A") async throws -> ConfirmedActionRequest {
  try await fixture.next(fixture.a, "/pods/decision").respond(body: decisionSnapshot(decision))
  let post = try await fixture.a.next()
  try #require(post.request.httpMethod == "POST")
  try #require(post.request.url?.path == "/pods/decision/message")
  return post
}

@MainActor
private func settleReply(_ fixture: PodStoreLifetimeFixture, post: ConfirmedActionRequest,
  task: Task<DecisionReplyOutcome, Never>, status: Int = 200) async throws -> DecisionReplyOutcome {
  post.respond(status: status, body: status == 200 ? "{\"ok\":true}" : "{\"error\":\"synthetic\"}")
  try await fixture.next(fixture.a, "/pods/decision").respond(status: 500, body: "{\"error\":\"unavailable\"}")
  return await task.value
}

@Suite(.serialized)
@MainActor
struct DecisionReplyOwnershipTests {
  @Test func draftKeysSeparateSourcePodDecisionAndRetainDisconnectedText() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      f.store.upsertSession(try decisionPod("A", podId: "other"))
      let handler = replyHandler(f)
      let a = handler.actions.decisionReply
      a.edit("decision", "A", "retained")
      #expect(a.snapshot("other", "A").text.isEmpty)
      #expect(a.snapshot("decision", nil).canEdit == false)
      f.store.disconnect()
      a.edit("decision", "A", "offline edit")
      #expect(a.snapshot("decision", "A").text == "offline edit")
      #expect(a.snapshot("decision", "A").canSubmit == false)
      #expect(await a.submit("decision", "A").value == .notAdmitted)
      f.store.configure(api: f.apiA)
      let reconnect = replyHandler(f)
      #expect(reconnect.actions.decisionReply.snapshot("decision", "A").text == "offline edit")
      f.store.setEscalation("decision", question: "same question", options: [], id: "B", type: "ask_human")
      #expect(reconnect.actions.decisionReply.snapshot("decision", "B").text.isEmpty)
      #expect(a.snapshot("decision", "A").canEdit == false)
      f.store.configure(api: f.apiB)
      f.store.upsertSession(try decisionPod("A"))
      let other = replyHandler(f, api: f.apiB)
      #expect(other.actions.decisionReply.snapshot("decision", "A").text.isEmpty)
      a.edit("decision", "A", "stale write")
      #expect(a.snapshot("decision", "A").text.isEmpty)
      f.store.configure(api: f.apiA, connectionID: UUID())
      f.store.upsertSession(try decisionPod("A"))
      let otherUUID = replyHandler(f)
      #expect(otherUUID.actions.decisionReply.snapshot("decision", "A").text.isEmpty)
      #expect(f.a.requests.isEmpty && f.b.requests.isEmpty)
    }
  }

  @Test(arguments: ["failed", "mismatch", "answered", "resolved"])
  func preflightRejectsWithoutPost(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = replyHandler(f); let actions = handler.actions.decisionReply
      actions.edit("decision", "A", "keep")
      let task = f.track(actions.submit("decision", "A"))
      let get = try await f.next(f.a, "/pods/decision")
      if kind == "failed" { get.respond(status: 500, body: "{}") }
      else {
        // A newer event preserves A in the model even if the actual response names B.
        if kind == "mismatch" { f.store.setEscalation("decision", question: "Question A?", options: [], id: "A", type: "ask_human") }
        get.respond(body: try decisionSnapshot(kind == "resolved" ? nil : kind == "mismatch" ? "B" : "A", answered: kind == "answered"))
      }
      #expect(await task.value == .notAdmitted)
      #expect(f.a.requests.count == 1)
      let key = DecisionReplyStore.Key(source: try #require(f.store.retainedSource), podID: "decision", decisionID: "A")
      #expect(f.store.decisionReplies.read(key)?.text == "keep")
      #expect(f.store.decisionReplies.read(key)?.task == nil)
    }
  }

  @Test func synchronousDuplicateAdmissionAcknowledgesBeforeHeldRefreshAndPreservesNewEdit() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = replyHandler(f); let actions = handler.actions.decisionReply
      actions.edit("decision", "A", "first")
      let task = f.track(actions.submit("decision", "A"))
      let duplicate = f.track(actions.submit("decision", "A"))
      #expect(actions.snapshot("decision", "A").pending)
      let post = try await replyPost(f)
      actions.edit("decision", "A", "newer edit")
      post.respond(body: "{\"ok\":true}")
      let refresh = try await f.next(f.a, "/pods/decision")
      let held = actions.snapshot("decision", "A")
      #expect(held.acknowledged && held.pending && !held.canSubmit)
      #expect(held.text == "newer edit")
      #expect(f.store.pods[0].status == .awaitingInput)
      refresh.respond(status: 500, body: "{}")
      #expect(await task.value == .acknowledged)
      #expect(await duplicate.value == .acknowledged)
      actions.discard("decision", "A")
      actions.edit("decision", "A", "must not repeat")
      #expect(await actions.submit("decision", "A").value == .notAdmitted)
      #expect(f.a.requests.count == 3)
      #expect(!actions.snapshot("decision", "A").pending)
    }
  }

  @Test(arguments: ["500", "transport"])
  func failedPostRetainsSelectedAnswerAndExplicitRetry(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = replyHandler(f); let actions = handler.actions.decisionReply
      actions.edit("decision", "A", "typed")
      actions.edit("decision", "A", "approved")
      let task = f.track(actions.submit("decision", "A"))
      let post = try await replyPost(f)
      #expect(try JSONSerialization.jsonObject(with: replyRequestData(post.request)) as? [String: String] == ["message": "approved"])
      if kind == "500" { post.respond(status: 500, body: "{}") }
      else { post.fail(URLError(.networkConnectionLost)) }
      let refresh = try await f.next(f.a, "/pods/decision")
      #expect(actions.snapshot("decision", "A").notice?.contains("unconfirmed") == true)
      refresh.respond(body: try decisionSnapshot("A"))
      #expect(await task.value == .unconfirmed)
      #expect(actions.snapshot("decision", "A").text == "approved")
      let retry = f.track(actions.submit("decision", "A"))
      let retryPost = try await replyPost(f)
      #expect(try JSONSerialization.jsonObject(with: replyRequestData(retryPost.request)) as? [String: String] == ["message": "approved"])
      #expect(try await settleReply(f, post: retryPost, task: retry) == .acknowledged)
      #expect(actions.snapshot("decision", "A").text.isEmpty)
      #expect(f.a.requests.count == 6)
    }
  }

  @Test func reconnectJoinsOldAttemptAndCannotClearOrRefresh() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = replyHandler(f); let old = handler.actions.decisionReply
      old.edit("decision", "A", "kept after reconnect")
      let task = f.track(old.submit("decision", "A"))
      let post = try await replyPost(f)
      f.store.disconnect(); f.store.configure(api: f.apiA)
      let current = replyHandler(f); let fresh = current.actions.decisionReply
      let duplicate = f.track(fresh.submit("decision", "A"))
      #expect(fresh.snapshot("decision", "A").pending)
      post.respond(body: "{\"ok\":true}")
      #expect(await task.value == .unconfirmed)
      #expect(await duplicate.value == .unconfirmed)
      #expect(fresh.snapshot("decision", "A").text == "kept after reconnect")
      #expect(f.a.requests.count == 2)
    }
  }

  @Test(arguments: ["source", "decision", "removal", "cancel"])
  func obsoleteCompletionCannotClearReplacement(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = replyHandler(f); let actions = handler.actions.decisionReply
      actions.edit("decision", "A", "original")
      let task = f.track(actions.submit("decision", "A"))
      let post = try await replyPost(f)
      if kind == "source" {
        f.store.configure(api: f.apiB); f.store.upsertSession(try decisionPod("A"))
      } else if kind == "decision" {
        f.store.setEscalation("decision", question: "B", options: [], id: "B", type: "ask_human")
        actions.edit("decision", "B", "replacement")
      } else if kind == "removal" {
        f.store.removeSession("decision"); f.store.upsertSession(try decisionPod("A"))
        actions.edit("decision", "A", "replacement")
        let joined = f.track(actions.submit("decision", "A"))
        #expect(actions.snapshot("decision", "A").pending)
        post.respond(body: "{\"ok\":true}")
        #expect(await joined.value == .unconfirmed)
      } else {
        actions.discard("decision", "A")
        let caller = f.track(Task { await actions.submit("decision", "A").value })
        caller.cancel()
        #expect(actions.snapshot("decision", "A").pending)
        post.respond(body: "{\"ok\":true}")
        try await f.next(f.a, "/pods/decision").respond(status: 500, body: "{}")
        #expect(await caller.value == .acknowledged)
      }
      if kind != "cancel" && kind != "removal" { post.respond(body: "{\"ok\":true}") }
      #expect(await task.value == (kind == "cancel" ? .acknowledged : .unconfirmed))
      if kind == "decision" { #expect(actions.snapshot("decision", "B").text == "replacement") }
      if kind == "removal" { #expect(actions.snapshot("decision", "A").text == "replacement") }
      #expect(f.a.requests.count == (kind == "cancel" ? 3 : 2))
    }
  }

  @Test func realPreparationRejectsFailuresAndPreservesNewerDecision() async throws {
    try await withDecisionIdentityFixture { f in
      f.store.upsertSession(try decisionPod(nil))
      let handler = replyHandler(f.rest); let actions = handler.actions.decisionReply
      #expect(actions.snapshot("decision", nil).canSubmit == false)
      let failed = f.rest.track(Task { await actions.prepare("decision") })
      try await f.rest.next(f.rest.a, "/pods/decision").respond(status: 500, body: "{}")
      if case .ready = await failed.value { Issue.record("Failed GET must not prepare a question") }
      let first = f.rest.track(Task { await actions.prepare("decision") })
      let second = f.rest.track(Task { await actions.prepare("decision") })
      let a = try await f.rest.next(f.rest.a, "/pods/decision")
      let b = try await f.rest.next(f.rest.a, "/pods/decision")
      try await f.created("B")
      a.respond(body: try decisionSnapshot("A")); b.respond(body: try decisionSnapshot("A"))
      #expect(await first.value == .ready)
      #expect(await second.value == .ready)
      #expect(actions.pod("decision")?.escalationId == "B")
      #expect(f.rest.a.requests.count == 3)
    }
  }

  @Test func preparationCannotPublishIntoReinsertedPod() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod(nil))
      let handler = replyHandler(f); let actions = handler.actions.decisionReply
      let pending = f.track(Task { await actions.prepare("decision") })
      let get = try await f.next(f.a, "/pods/decision")
      f.store.removeSession("decision")
      f.store.upsertSession(try decisionPod("B"))
      get.respond(body: try decisionSnapshot("A"))
      if case .ready = await pending.value { Issue.record("Retired preparation must fail") }
      #expect(f.store.pods.first?.escalationId == "B")
      #expect(f.a.requests.count == 1)
    }
  }

  @Test(arguments: ["preflight", "post"])
  func earlyFailureJoinsOwnedTasks(kind: String) async throws {
    enum FixtureStop: Error { case expected }
    var actions = DecisionReplyActions()
    var retainedHandler: ActionHandler?
    do {
      try await withPodStoreLifetimeFixture { f in
        f.store.upsertSession(try decisionPod("A"))
        retainedHandler = replyHandler(f)
        actions = try #require(retainedHandler).actions.decisionReply
        actions.edit("decision", "A", "kept")
        f.track(actions.submit("decision", "A"))
        if kind == "post" { _ = try await replyPost(f) }
        else { _ = try await f.next(f.a, "/pods/decision") }
        throw FixtureStop.expected
      }
    } catch FixtureStop.expected {}
    #expect(!actions.snapshot("decision", "A").pending)
    #expect(actions.snapshot("decision", "A").text == "kept")
    withExtendedLifetime(retainedHandler) {}
  }

  @Test func missingHandlerAndDefaultsNeverAcknowledge() async {
    let actions = PodActions().decisionReply
    #expect(await actions.submit("decision", "A").value == .notAdmitted)
    let f = PodStoreLifetimeFixture()
    var handler: ActionHandler? = replyHandler(f)
    let missing = handler!.actions.decisionReply
    handler = nil
    #expect(await missing.submit("decision", "A").value == .notAdmitted)
    await f.dispose()
  }
}
