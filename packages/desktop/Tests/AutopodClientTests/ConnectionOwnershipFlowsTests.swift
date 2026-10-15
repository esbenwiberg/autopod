import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor @Suite struct ConnectionOwnershipFlowsTests {
  @Test(arguments: ["same", "uuid", "url", "aba", "fallback"])
  func sourceIdentitySeparatesCacheFromAuthority(change: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let id = UUID()
      f.store.configure(api: f.apiA, connectionID: change == "fallback" ? nil : id)
      f.store.upsertSession(try decisionPod("A", podId: "pod"))
      f.store.selectedSessionId = "pod"
      let diff = f.start { await f.store.loadDiff("pod") }
      try await f.next(f.a, "/pods/pod/diff").respond(body: lifetimeDiff("A")); _ = await diff.value
      let scores = f.start { await f.store.loadQualityScores() }
      try await f.next(f.a, "/pods/scores").respond(body: lifetimeScores("pod")); _ = await scores.value
      let series = f.start { _ = await f.store.loadSeries("series") }
      try await f.next(f.a, "/pods/series/series").respond(body: lifetimeSeries("pod")); _ = await series.value
      let old = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      f.store.disconnect()
      #expect(f.store.selectedSession?.escalationId == "A")
      if change == "aba" { f.store.configure(api: f.apiB, connectionID: id) }
      let nextAPI = change == "url" ? f.apiB : f.additionalAPI(for: f.a)
      f.store.configure(api: nextAPI, connectionID: change == "uuid" ? UUID() : change == "fallback" ? nil : id)
      let retained = change == "same" || change == "fallback"
      #expect((f.store.selectedSession?.escalationId == "A") == retained)
      #expect(f.store.pods.isEmpty == !retained)
      #expect(f.store.sessionDiffs.isEmpty == !retained)
      #expect(f.store.qualityScores.isEmpty == !retained)
      #expect(f.store.seriesCache.isEmpty == !retained)
      let before = f.a.requests.count
      await old.approve("pod")
      #expect(f.a.requests.count == before)
      #expect(old.lastError?.contains("Connection changed") == true)
      let current = ActionHandler(api: nextAPI, podStore: f.store, profileStore: ProfileStore())
      let task = f.start { await current.approve("pod") }
      try await (change == "url" ? f.b : f.a).next().respond(body: #"{"ok":true}"#)
      _ = await task.value
      #expect(current.lastError == nil)
    }
  }

  @Test func initialConfigurationAndMismatchedHandlerHaveNoInheritedAuthority() async throws {
    try await withPodStoreLifetimeFixture { f in
      let store = PodStore()
      store.upsertSession(try decisionPod("unowned"))
      store.selectedSessionId = "decision"
      let beforeConfiguration = ActionHandler(api: f.apiA, podStore: store, profileStore: ProfileStore())
      store.configure(api: f.apiA)
      #expect(store.pods.isEmpty && store.selectedSessionId == nil)
      let mismatched = ActionHandler(api: f.apiB, podStore: store, profileStore: ProfileStore())
      await beforeConfiguration.approve("pod")
      await mismatched.approve("pod")
      #expect(f.a.requests.isEmpty && f.b.requests.isEmpty)
    }
  }

  @Test(arguments: [false, true])
  func disconnectFencesRestAndAdmission(fails: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("pod")
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let old = f.start { await f.store.loadSessions() }
      let response = try await f.a.next()
      f.store.disconnect()
      if fails { response.respond(status: 503, body: #"{"error":"old failure"}"#) }
      else { response.respond(body: lifetimePage(id: "old", hasNext: false)) }
      _ = await old.value
      await handler.reply("pod", message: "obsolete")
      #expect(f.a.requests.count == 1)
      #expect(f.store.pods.map(\.id) == ["pod"])
      #expect(f.store.error == nil && !f.store.isLoading)
    }
  }

  @Test(arguments: ["kill", "refresh"])
  func combinedDeleteCannotCrossOwnership(stage: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.start { await handler.killAndDelete("pod") }
      let kill = try await f.a.next()
      var held = kill
      if stage == "refresh" {
        kill.respond(body: #"{"ok":true}"#)
        held = try await f.next(f.a, "/pods/pod")
      }
      f.store.configure(api: f.apiA)
      f.seed("pod", task: "new authority")
      held.respond(body: stage == "kill" ? #"{"ok":true}"# : lifetimePod(id: "pod"))
      _ = await task.value
      #expect(f.a.requests.count == (stage == "kill" ? 1 : 2))
      #expect(!f.a.requests.contains { $0.httpMethod == "DELETE" })
      #expect(handler.pendingControl("pod") == nil)
      #expect(f.store.pods.first?.task == "new authority")
    }
  }

  @Test(arguments: ["approve", "reply", "pause", "kill-delete", "delete", "goal", "retry", "rework-retry", "resume-retry", "read"])
  func obsoleteEntryPointsDoNotSend(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      f.store.configure(api: f.apiA)
      do {
        switch kind {
        case "approve": await handler.approve("pod")
        case "reply": await handler.reply("pod", message: "old")
        case "pause": await handler.pause("pod")
        case "kill-delete": await handler.killAndDelete("pod")
        case "delete": await handler.deletePod("pod")
        case "goal": _ = try await handler.actions.controlGoal("pod", PodGoalControlRequest(revision: 1, intent: "resume"))
        case "retry": _ = try await handler.actions.authorizeRetry("pod", TaskRetryAuthorizationRequest(requestKey: "key", reason: "fixture", stage: "worker"))
        case "rework-retry": try await handler.actions.reworkRetry("pod")
        case "resume-retry": try await handler.actions.resumeRetry("pod")
        default: _ = try await handler.actions.loadGoal("pod")
        }
        #expect(handler.lastError?.contains("Connection changed") == true)
      } catch { #expect(error.localizedDescription.contains("Connection changed")) }
      #expect(f.a.requests.isEmpty && f.b.requests.isEmpty)
    }
  }

  @Test(arguments: [200, 404, 503], [false, true])
  func goalResultsAndErrorsBelongToTheirOwner(status: Int, superseded: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.startResult {
        do { return try await handler.actions.loadGoal("pod") == nil ? "absent" : "goal" }
        catch { return error.localizedDescription }
      }
      let response = try await f.a.next()
      if superseded { f.store.configure(api: f.apiA) }
      response.respond(status: status, body: status == 200 ? connectionGoal : #"{"error":"fixture failure"}"#)
      let result = await task.value
      if superseded { #expect(result?.contains("Connection changed") == true) }
      else { #expect(result == (status == 200 ? "goal" : status == 404 ? "absent" : "Server error (503): fixture failure")) }
    }
  }

  @Test(arguments: ["create", "rerun", "waiver"], [false, true])
  func directPublicationAndReturnedIDsRequireCurrentOwner(kind: String, superseded: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.startResult {
        do {
          switch kind {
          case "create": return await handler.createPod(profileName: "fixture", task: "Synthetic", model: nil, pod: nil, baseBranch: nil)
          case "rerun": return try await handler.actions.createIntentionalRerun(JSONDecoder().decode(IntentionalRerunDraft.self, from: Data(#"{"intentionalRerun":{"ofPodId":"pod","reason":"Synthetic","requestKey":"fixture"}}"#.utf8)))
          default: await handler.approveFactWaiver("pod", factId: "fact", reason: nil); return nil
          }
        } catch { return error.localizedDescription }
      }
      var held = try await f.a.next()
      if kind == "waiver" {
        held.respond(body: #"{"ok":true}"#)
        held = try await f.next(f.a, "/pods/pod")
      }
      if superseded { f.store.configure(api: f.apiB); f.seed("pod", task: "B owned") }
      held.respond(body: lifetimePod(id: "pod"))
      let result = await task.value
      if superseded {
        #expect(f.store.pods.first?.task == "B owned")
        #expect(kind == "rerun" ? result?.contains("Connection changed") == true : result == nil)
      } else {
        #expect(f.store.pods.first?.task == "Full detail task")
        #expect(result == (kind == "waiver" ? nil : "pod"))
      }
      #expect(f.a.requests.count == (kind == "waiver" ? 2 : 1) && f.b.requests.isEmpty)
    }
  }

  @Test(arguments: ["approve-all", "kill-failed", "waiver", "delete-series"])
  func oldResponsesCannotStartFollowupOrRemoveSeries(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.start {
        switch kind {
        case "approve-all": await handler.approveAllValidated()
        case "kill-failed": await handler.killAllFailed()
        case "waiver": await handler.approveFactWaiver("pod", factId: "fact", reason: nil)
        default: await handler.deleteSeries("series")
        }
      }
      let held = try await f.a.next()
      f.store.configure(api: f.apiB)
      var pod = try decisionPod("B", podId: "pod"); pod.seriesId = "series"
      f.store.upsertSession(pod)
      held.respond(body: kind == "approve-all" ? #"{"approved":[],"skipped":[]}"# : kind == "kill-failed" ? "[]" : #"{"ok":true}"#)
      _ = await task.value
      #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
      #expect(f.store.pods.first?.escalationId == "B")
      #expect(handler.lastError?.contains("Connection changed") == true)
    }
  }
}

let connectionGoal = #"{"podId":"pod","objective":"Tests pass","state":"paused","revision":1,"runtime":"codex","nativeSessionId":"native","nativeStatus":"paused","executionStopped":true,"controlIntent":null,"observedTokens":0,"observedSeconds":0,"reason":null,"createdAt":"created","updatedAt":"updated"}"#
