import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor @Suite struct DecisionIdentityTests {
  @Test(arguments: [false, true]) func detailMappingUsesOnlyUnansweredIdentity(answered: Bool) throws {
    let response = try JSONDecoder().decode(SessionResponse.self, from: Data(decisionSnapshot("A", answered: answered).utf8))
    let pod = PodMapper.map(response)
    #expect(pod.escalationId == (answered ? nil : "A"))
    #expect(pod.escalationQuestion == (answered ? nil : "Question A?"))
    #expect(pod.escalationOptions == (answered ? nil : ["A first", "A second"]))
    #expect(pod.escalationType == (answered ? nil : "ask_human"))
    #expect(try decisionPod("").escalationId == nil)
    #expect(try decisionPod(nil).escalationId == nil)
  }

  @Test func mismatchedUnknownEmptyAndDuplicateResolutionsOnlyRefresh() async throws {
    try await withDecisionIdentityFixture { f in
      try await f.created("B")
      for id in ["A", ""] {
        let request = try await f.resolved(id)
        try f.expectDecision("B")
        #expect(f.store.selectedSession?.status == .awaitingInput)
        request.fail(URLError(.cannotConnectToHost))
      }
      // Unknown model identity cannot be inferred from the question text.
      f.store.setEscalation(f.id, question: "Question B?", options: ["B first", "B second"])
      let unknown = try await f.resolved("B")
      #expect(f.store.selectedSession?.escalationQuestion == "Question B?")
      #expect(f.store.selectedSession?.status == .awaitingInput)
      unknown.respond(body: try decisionSnapshot(nil, status: "validating"))
      try await decisionWait { f.store.selectedSession?.status == .validating }
      try f.expectDecision(nil)
      let duplicate = try await f.resolved("B")
      try f.expectDecision(nil)
      #expect(f.store.selectedSession?.status == .validating)
      duplicate.fail(URLError(.cannotConnectToHost))
      #expect(f.rest.a.requests.count == 4)
      #expect(f.rest.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  @Test(arguments: ["validating", "running", "awaiting_input"])
  func matchingResolutionClearsGroupAndRESTEstablishesLifecycle(status: String) async throws {
    try await withDecisionIdentityFixture { f in
      try await f.created("B")
      let request = try await f.resolved("B")
      try f.expectDecision(nil)
      #expect(f.store.selectedSession?.status == .awaitingInput)
      request.respond(body: try decisionSnapshot(status == "awaiting_input" ? "C" : nil, status: status))
      try await decisionWait {
        status == "awaiting_input" ? f.store.selectedSession?.escalationId == "C" : f.store.selectedSession?.status.rawValue == status
      }
      try f.expectDecision(status == "awaiting_input" ? "C" : nil)
    }
  }

  @Test(arguments: ["2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"], [false, true])
  func heldDetailCannotReplaceCreatedDecision(date: String, absent: Bool) async throws {
    try await withDecisionIdentityFixture { f in
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let held = try await f.rest.next(f.rest.a, "/pods/decision")
      try await f.created("B")
      held.respond(body: try decisionSnapshot(absent ? nil : "A", status: "running", date: date))
      _ = await task.value
      try f.expectDecision("B")
      #expect(f.store.selectedSession?.status == .awaitingInput)
    }
  }

  @Test func heldDetailCannotResurrectResolvedDecisionAndFreshRequestCanReconcile() async throws {
    try await withDecisionIdentityFixture { f in
      try await f.created("B")
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let held = try await f.rest.next(f.rest.a, "/pods/decision")
      let fresh = try await f.resolved("B")
      held.respond(body: try decisionSnapshot("B"))
      _ = await task.value
      try f.expectDecision(nil)
      fresh.respond(body: try decisionSnapshot("C"))
      try await decisionWait { f.store.selectedSession?.escalationId == "C" }
      try f.expectDecision("C")
    }
  }

  @Test func olderFullDetailPreservesDecisionWhileHydratingOtherFields() async throws {
    try await withDecisionIdentityFixture { f in
      f.store.upsertSession(try decisionPod("B", date: "2026-10-16T00:00:00Z"))
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let request = try await f.rest.next(f.rest.a, "/pods/decision")
      request.respond(body: try decisionSnapshot("A", status: "running"))
      _ = await task.value
      try f.expectDecision("B")
      #expect(f.store.selectedSession?.status == .awaitingInput)
      #expect(f.store.selectedSession?.updatedAt == ISO8601DateFormatter().date(from: "2026-10-16T00:00:00Z"))
      #expect(f.store.selectedSession?.task == "Choose the implementation to preserve")
    }
  }

  @Test(arguments: [false, true]) func heldCompactPreservesWholeCreatedOrResolvedGroup(resolved: Bool) async throws {
    try await withDecisionIdentityFixture { f in
      let task = f.rest.start { await f.store.loadSessions() }
      let held = try await f.rest.next(f.rest.a, "/pods")
      try await f.created("B")
      if resolved { let refresh = try await f.resolved("B"); refresh.fail(URLError(.cannotConnectToHost)) }
      held.respond(body: try decisionPage("Stale compact A"))
      try await f.rest.next(f.rest.a, "/pods/scores").respond(body: "[]")
      _ = await task.value
      try f.expectDecision(resolved ? nil : "B")
      #expect(f.store.selectedSessionId == f.id)
      #expect(f.rest.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  @Test func newerCompactDropsUnknownIdentityThenSelectedFreshHydrationCanReconcile() async throws {
    try await withDecisionIdentityFixture { f in
      let hydration = f.rest.start { await f.store.refreshSession(f.id) }
      try await f.rest.next(f.rest.a, "/pods/decision").respond(body: try decisionSnapshot("A"))
      _ = await hydration.value
      let list = f.rest.start { await f.store.loadSessions() }
      let held = try await f.rest.next(f.rest.a, "/pods")
      try await f.created("B")
      held.respond(body: try decisionPage("Older snapshot A"))
      let rehydrate = try await f.rest.next(f.rest.a, "/pods/decision")
      try f.expectDecision("B")
      rehydrate.respond(body: try decisionSnapshot("C", date: "2026-10-16T00:00:00Z"))
      try await f.rest.next(f.rest.a, "/pods/scores").respond(body: "[]")
      _ = await list.value
      try f.expectDecision("C")
      // A later compact discovery has no current decision identity on the wire.
      f.store.selectedSessionId = nil
      let fresh = f.rest.start { await f.store.loadSessions() }
      try await f.rest.next(f.rest.a, "/pods").respond(body: try decisionPage("New summary", date: "2026-10-17T00:00:00Z"))
      try await f.rest.next(f.rest.a, "/pods/scores").respond(body: "[]")
      _ = await fresh.value
      #expect(f.store.pods.first?.escalationId == nil)
      #expect(f.store.pods.first?.escalationQuestion == "New summary")
      #expect(f.store.pods.first?.escalationOptions == nil)
      #expect(f.store.pods.first?.escalationType == nil)
    }
  }

  @Test func removedPodCannotReuseDecisionRevisionAndOtherPodIsIndependent() async throws {
    try await withDecisionIdentityFixture { f in
      try await f.created("A") // Held request captures nonzero revision 1.
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let held = try await f.rest.next(f.rest.a, "/pods/decision")
      f.store.removeSession(f.id)
      f.store.upsertSession(try decisionPod(nil))
      try await f.created("B")
      f.store.upsertSession(try decisionPod("X", podId: "other"))
      try await f.created("Y", podId: "other")
      held.respond(body: try decisionSnapshot("A"))
      _ = await task.value
      try f.expectDecision("B")
      try f.expectDecision("Y", podId: "other")
      #expect(f.store.selectedSessionId == nil)
    }
  }

  @Test func epochReplacementRejectsOldDetailDecision() async throws {
    try await withDecisionIdentityFixture { f in
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let held = try await f.rest.next(f.rest.a, "/pods/decision")
      f.store.configure(api: f.rest.apiB)
      f.store.upsertSession(try decisionPod("B"))
      held.respond(body: try decisionSnapshot("A", date: "2026-10-17T00:00:00Z"))
      _ = await task.value
      try f.expectDecision("B")
      #expect(f.rest.b.requests.isEmpty)
    }
  }

  @Test func sameQuestionStillHasDistinctIdentityAndMalformedResolutionIsDropped() async throws {
    try await withDecisionIdentityFixture { f in
      try await f.created("A", question: "Same question?")
      try await f.created("B", question: "Same question?")
      let stale = try await f.resolved("A")
      try f.expectDecision("B", question: "Same question?")
      stale.fail(URLError(.cannotConnectToHost))
      let malformed = try decisionEvent("pod.escalation_resolved")
      #expect(SystemEvent.parse(malformed) == nil)
      f.socket.callbacks.event(malformed)
      // Bounded negative observation; no refresh is emitted for a dropped event.
      try await Task.sleep(for: .milliseconds(100))
      #expect(f.rest.a.requests.count == 1)
      try f.expectDecision("B", question: "Same question?")
    }
  }
}
