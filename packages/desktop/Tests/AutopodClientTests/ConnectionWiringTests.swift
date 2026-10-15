import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop

@MainActor @Suite struct ConnectionWiringTests {
  @Test func connectedReplacementRecoveryAndDisconnectShareOneGate() async throws {
    try await withPodStoreLifetimeFixture { f in
      var gate = DesktopConnectionWiringGate()
      let id = UUID()
      var handler: ActionHandler?
      var configurations = 0
      @MainActor func wire(_ api: DaemonAPI, _ uuid: UUID, force: Bool = false) {
        let identity = DesktopConnectionIdentity(isConnected: true, connectionID: uuid, api: api)!
        guard gate.admit(identity, force: force) else { return }
        f.store.configure(api: api, connectionID: uuid)
        handler = ActionHandler(api: api, podStore: f.store, profileStore: ProfileStore())
        configurations += 1
      }
      #expect(DesktopConnectionIdentity(isConnected: false, connectionID: id, api: f.apiA) == nil)
      #expect(DesktopConnectionIdentity(isConnected: true, connectionID: nil, api: f.apiA) == nil)
      wire(f.apiA, id)
      f.store.upsertSession(try decisionPod("A")); f.store.selectedSessionId = "decision"
      let first = try #require(handler)
      wire(f.apiA, id)
      #expect(configurations == 1)
      let replacementAPI = f.additionalAPI(for: f.a)
      wire(replacementAPI, id) // isConnected never changed.
      #expect(configurations == 2 && f.store.selectedSession?.escalationId == "A")
      await first.approve("pod")
      #expect(f.a.requests.isEmpty)
      let second = try #require(handler)
      let request = f.start { await second.approve("pod") }
      try await f.a.next().respond(body: #"{"ok":true}"#); _ = await request.value
      #expect(second.lastError == nil)
      let failed = await recoverDesktopConnection(recover: { false }, onRecovered: { wire(replacementAPI, id, force: true) })
      #expect(!failed && configurations == 2)
      let recovered = await recoverDesktopConnection(recover: {
        await Task.yield()
        #expect(configurations == 2)
        return true
      }, onRecovered: { wire(replacementAPI, id, force: true) })
      #expect(recovered && configurations == 3)
      let third = try #require(handler)
      wire(replacementAPI, id)
      #expect(configurations == 3)
      await second.approve("pod")
      #expect(f.a.requests.count == 1)
      let fresh = f.start { await third.approve("pod") }
      try await f.a.next().respond(body: #"{"ok":true}"#); _ = await fresh.value
      #expect(third.lastError == nil)
      f.store.disconnect(); gate.disconnect()
      await third.approve("pod")
      #expect(f.a.requests.count == 2)
      wire(replacementAPI, id)
      #expect(configurations == 4 && f.store.selectedSession?.escalationId == "A")
      wire(replacementAPI, UUID())
      #expect(configurations == 5 && f.store.pods.isEmpty && f.store.selectedSessionId == nil)
    }
  }

  @Test func retainedOldStreamCannotMutateOrAdmitAfterReplacement() async throws {
    try await withDecisionIdentityFixture { f in
      f.stream.disconnect()
      try await f.socket.log.waitFor("disconnect")
      f.store.configure(api: f.rest.apiB)
      f.store.upsertSession(try decisionPod("B")); f.store.selectedSessionId = f.id
      var socket: DecisionIdentitySocket?
      let replacement = EventStream(podStore: f.store, socketFactory: { _, _, _, callbacks in
        let made = DecisionIdentitySocket(callbacks); socket = made; return made
      }, notifyEscalation: { _, _ in })
      replacement.connect(baseURL: f.rest.apiB.baseURL, token: "synthetic", api: f.rest.apiB)
      let current = try #require(socket)
      do {
        try await current.log.waitFor("connect")
        f.socket.callbacks.event(try decisionEvent("pod.escalation_created", extra: ["escalation": decisionEscalation("old")]))
        f.socket.callbacks.event(try decisionEvent("pod.escalation_resolved", extra: ["escalationId": "B"]))
        current.callbacks.event(try decisionEvent("pod.escalation_created", extra: ["escalation": decisionEscalation("C")]))
        try await decisionWait { f.store.selectedSession?.escalationId == "C" }
        try await Task.sleep(for: .milliseconds(100))
        #expect(f.rest.a.requests.isEmpty && f.rest.b.requests.isEmpty)
        #expect(f.store.selectedSession?.escalationId == "C")
        #expect(f.notifications.values.isEmpty)
      } catch {
        replacement.disconnect(); try await current.log.waitFor("disconnect"); throw error
      }
      replacement.disconnect(); try await current.log.waitFor("disconnect")
    }
  }
}
