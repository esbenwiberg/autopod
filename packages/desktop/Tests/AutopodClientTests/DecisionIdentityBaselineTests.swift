import Foundation
import Observation
import Testing
import AutopodClient
@testable import AutopodDesktop

private actor BaselineDecisionSocket: EventStreamSocket {
  let log = SocketLifetimeLog()
  func connect() { log.add("connect") }
  func disconnect() { log.add("disconnect") }
  func subscribe(podId: String) {}
  func unsubscribe(podId: String) {}
}

@MainActor @Suite struct DecisionIdentityBaselineTests {
  @Test(arguments: [false, true]) func heldRESTCannotReplaceNewQuestion(compact: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("decision")
      let task = f.start { if compact { await f.store.loadSessions() } else { await f.store.refreshSession("decision") } }
      let request = try await f.next(f.a, compact ? "/pods" : "/pods/decision")
      f.store.setEscalation("decision", question: "New question B", options: ["B choice"])
      request.respond(body: compact ? lifetimePage(id: "decision", hasNext: false) : lifetimePod(id: "decision"))
      if compact { try await f.next(f.a, "/pods/scores").respond(body: "[]") }
      _ = await task.value
      #expect(f.store.pods.first?.escalationQuestion == "New question B")
      #expect(f.store.pods.first?.escalationOptions == ["B choice"])
    }
  }

  @Test func oldResolutionCannotClearNewQuestionOrInventRunning() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("decision")
      f.store.setEscalation("decision", question: "New question B", options: ["B choice"])
      f.store.updateStatus("decision", to: .awaitingInput)
      let socket = BaselineDecisionSocket()
      var callbacks: EventStreamSocketCallbacks?
      let stream = EventStream(podStore: f.store, socketFactory: { _, _, _, value in callbacks = value; return socket })
      stream.connect(baseURL: f.apiA.baseURL, token: "synthetic", api: f.apiA)
      try await socket.log.waitFor("connect")
      let observed = SocketLifetimeLog()
      withObservationTracking { _ = f.store.pods } onChange: { observed.add("changed") }
      let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data(#"{"type":"pod.escalation_resolved","podId":"decision","escalationId":"A","timestamp":"2026-10-15T00:00:00Z"}"#.utf8))
      callbacks?.event(raw)
      try await observed.waitFor("changed")
      #expect(f.store.pods.first?.escalationQuestion == "New question B")
      #expect(f.store.pods.first?.status == .awaitingInput)
      stream.disconnect()
      try await socket.log.waitFor("disconnect")
    }
  }
}
