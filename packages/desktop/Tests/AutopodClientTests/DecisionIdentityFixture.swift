import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

actor DecisionIdentitySocket: EventStreamSocket {
  nonisolated let callbacks: EventStreamSocketCallbacks
  nonisolated let log = SocketLifetimeLog()
  init(_ callbacks: EventStreamSocketCallbacks) { self.callbacks = callbacks }
  func connect() { log.add("connect") }
  func disconnect() { log.add("disconnect") }
  func subscribe(podId: String) {}
  func unsubscribe(podId: String) {}
}

@MainActor final class DecisionIdentityFixture {
  let rest = PodStoreLifetimeFixture()
  let notifications = SocketLifetimeLog()
  let stream: EventStream
  let socket: DecisionIdentitySocket
  var store: PodStore { rest.store }
  let id = "decision"

  init() throws {
    var socket: DecisionIdentitySocket?
    let notifications = notifications
    stream = EventStream(podStore: rest.store, socketFactory: { _, _, _, callbacks in
      let created = DecisionIdentitySocket(callbacks); socket = created; return created
    }, notifyEscalation: { pod, question in notifications.add("\(pod.id):\(question)") })
    stream.connect(baseURL: rest.apiA.baseURL, token: "synthetic", api: rest.apiA)
    self.socket = try #require(socket)
    store.upsertSession(try decisionPod("A"))
    store.selectedSessionId = id
  }

  func created(_ decision: String, podId: String = "decision", question: String? = nil) async throws {
    let count = notifications.values.count
    socket.callbacks.event(try decisionEvent("pod.escalation_created", podId: podId,
      extra: ["escalation": decisionEscalation(decision, podId: podId, question: question)]))
    try await notifications.wait("created event dispatched") { $0.count == count + 1 }
  }

  func resolved(_ decision: String) async throws -> ConfirmedActionRequest {
    socket.callbacks.event(try decisionEvent("pod.escalation_resolved", extra: ["escalationId": decision]))
    // Admission to the real GET proves that EventStream processed the event.
    return try await rest.next(rest.a, "/pods/decision")
  }

  func expectDecision(_ decision: String?, question: String? = nil, podId: String = "decision") throws {
    let pod = try #require(store.pods.first { $0.id == podId })
    #expect(pod.escalationId == decision)
    #expect(pod.escalationQuestion == decision.map { question ?? "Question \($0)?" })
    #expect(pod.escalationOptions == decision.map { ["\($0) first", "\($0) second"] })
    #expect(pod.escalationType == decision.map { _ in "ask_human" })
  }

  func dispose() async throws {
    stream.disconnect()
    try await socket.log.waitFor("disconnect")
    // Invalidate any event-launched refresh before releasing the private transport.
    store.configure(api: rest.apiB)
    await rest.dispose()
  }
}

@MainActor func withDecisionIdentityFixture(_ body: (DecisionIdentityFixture) async throws -> Void) async throws {
  let fixture = try DecisionIdentityFixture()
  do {
    try await fixture.socket.log.waitFor("connect")
    try await body(fixture)
  } catch {
    try await fixture.dispose()
    throw error
  }
  try await fixture.dispose()
}

@MainActor func decisionWait(_ predicate: () -> Bool) async throws {
  let deadline = ContinuousClock.now.advanced(by: .seconds(5))
  while !predicate() {
    guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
    await Task.yield()
  }
}

func decisionEscalation(_ id: String, podId: String = "decision", question: String? = nil) -> [String: Any] {
  ["id": id, "podId": podId, "type": "ask_human", "timestamp": "2026-10-15T00:00:00Z",
   "payload": ["question": question ?? "Question \(id)?", "options": ["\(id) first", "\(id) second"]]]
}

func decisionJSON(_ object: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
}

func decisionSnapshot(_ decision: String?, podId: String = "decision", status: String = "awaiting_input",
  date: String = "2026-10-15T00:00:00Z", answered: Bool = false, question: String? = nil) throws -> String {
  var object = try #require(JSONSerialization.jsonObject(with: Data(lifetimePod(id: podId).utf8)) as? [String: Any])
  object["status"] = status
  object["updatedAt"] = date
  object["task"] = "Choose the implementation to preserve"
  object["briefTitle"] = "Decision identity fixture"
  if let decision {
    var escalation = decisionEscalation(decision, podId: podId, question: question)
    if answered { escalation["response"] = ["respondedAt": date, "respondedBy": "fixture", "response": "accepted"] }
    object["pendingEscalation"] = escalation
  }
  return try decisionJSON(object)
}

func decisionPod(_ decision: String?, podId: String = "decision", date: String = "2026-10-15T00:00:00Z") throws -> Pod {
  PodMapper.map(try JSONDecoder().decode(SessionResponse.self, from: Data(decisionSnapshot(decision, podId: podId, date: date).utf8)))
}

func decisionPage(_ question: String?, date: String = "2026-10-16T00:00:00Z") throws -> String {
  var object = try #require(JSONSerialization.jsonObject(with: Data(lifetimePage(id: "decision", hasNext: false, status: "awaiting_input", updatedAt: date).utf8)) as? [String: Any])
  var pods = try #require(object["pods"] as? [[String: Any]])
  pods[0]["pendingEscalationSummary"] = question ?? NSNull() as Any
  object["pods"] = pods
  return try decisionJSON(object)
}

func decisionEvent(_ type: String, podId: String = "decision", extra: [String: Any] = [:]) throws -> RawSystemEvent {
  var object: [String: Any] = ["type": type, "podId": podId, "timestamp": "2026-10-15T00:00:00Z"]
  object.merge(extra) { _, new in new }
  return try JSONDecoder().decode(RawSystemEvent.self, from: Data(decisionJSON(object).utf8))
}
