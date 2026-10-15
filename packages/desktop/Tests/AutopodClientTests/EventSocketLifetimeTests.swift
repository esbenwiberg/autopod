import Foundation
import Testing
@testable import AutopodClient

@MainActor @Suite("EventSocket lifetime")
struct EventSocketLifetimeTests {
  @Test func disconnectDuringTokenAcquisition() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket(heldToken: true)
      await socket.connect()
      try await fixture.gate.log.waitFor("entered")
      await socket.disconnect()
      fixture.gate.release()
      try await fixture.gate.log.waitFor("returned")
      // Intentional negative observation window after a deterministic token barrier.
      try await Task.sleep(for: .milliseconds(250))
      #expect(!fixture.callbacks.values.contains("state:connected"))
      #expect(!fixture.peer.log.values.contains { $0.hasPrefix("accepted:") })
    }
  }

  @Test func disconnectDuringBackoff() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket()
      await socket.connect()
      try await fixture.peer.subscribed(1)
      await fixture.peer.drop(1)
      try await fixture.callbacks.wait("reconnect entered") { $0.contains { $0.hasPrefix("state:reconnecting") } }
      await socket.disconnect()
      // First production backoff is one second; observe beyond that deadline.
      try await Task.sleep(for: .milliseconds(1300))
      #expect(fixture.peer.log.values.filter { $0.hasPrefix("accepted:") }.count == 1)
      #expect(fixture.callbacks.values.last == "state:disconnected")
    }
  }

  @Test func duplicateConnectKeepsOnePeer() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket()
      await socket.connect()
      try await fixture.peer.subscribed(1)
      await socket.connect()
      try await Task.sleep(for: .milliseconds(250))
      #expect(fixture.peer.log.values.filter { $0.hasPrefix("accepted:") }.count == 1)
      #expect(fixture.callbacks.values.filter { $0 == "state:connected" }.count == 1)
      await socket.disconnect()
      try await fixture.peer.log.waitFor("closed:1")
    }
  }

  @Test func lateTokenCannotReplaceNewLifetime() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket(heldToken: true)
      await socket.connect()
      try await fixture.gate.log.waitFor("entered")
      await socket.disconnect()
      await socket.connect()
      try await fixture.peer.subscribed(1)
      fixture.gate.release()
      try await fixture.gate.log.waitFor("returned")
      try await Task.sleep(for: .milliseconds(250))
      #expect(fixture.peer.log.values.filter { $0.hasPrefix("accepted:") }.count == 1)
      #expect(fixture.callbacks.values.filter { $0 == "state:connected" }.count == 1)
      try await fixture.peer.send(Self.event(42), to: 1)
      try await fixture.callbacks.waitFor("event:42")
      await socket.disconnect()
      try await fixture.peer.log.waitFor("closed:1")
    }
  }

  @Test func cancelledCallerCannotStartConnection() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket()
      let start = Task { await socket.connect() }
      start.cancel() // MainActor has not yielded to the queued actor hop yet.
      await start.value
      try await Task.sleep(for: .milliseconds(250))
      #expect(fixture.callbacks.values.isEmpty)
      #expect(fixture.peer.log.values.filter { $0.hasPrefix("accepted:") }.isEmpty)
    }
  }

  @Test func reconnectPreservesSubscriptionReplayAndControlMessages() async throws {
    try await withSocketLifetimeFixture { fixture in
      let socket = fixture.socket()
      await socket.connect()
      try await fixture.peer.subscribed(1)
      try await fixture.peer.send(Self.event(41), to: 1)
      try await fixture.callbacks.waitFor("event:41")
      try await fixture.peer.send(#"{"type":"replay_truncated"}"#, to: 1)
      try await fixture.callbacks.waitFor("resync")
      await fixture.peer.drop(1)
      try await fixture.callbacks.wait("automatic reconnect") { $0.contains { $0.hasPrefix("state:reconnecting") } }
      await socket.connect() // Reconnecting is also an active lifetime.
      try await fixture.peer.subscribed(2)
      try await fixture.peer.log.wait("replay observed event 41") { entries in
        entries.contains { $0.hasPrefix("frame:2:") && $0.contains("replay") && $0.contains("41") }
      }
      try await fixture.peer.send(Self.event(42), to: 2)
      try await fixture.callbacks.waitFor("event:42")
      await socket.disconnect()
      try await fixture.peer.log.waitFor("closed:2")
      // Bound the no-reconnect claim beyond the first production backoff.
      try await Task.sleep(for: .milliseconds(1300))
      #expect(fixture.peer.log.values.filter { $0.hasPrefix("accepted:") }.count == 2)
      await socket.connect()
      try await fixture.peer.subscribed(3)
      try await fixture.peer.send(Self.event(43), to: 3)
      try await fixture.callbacks.waitFor("event:43")
      await socket.disconnect()
      try await fixture.peer.log.waitFor("closed:3")
      #expect(fixture.callbacks.values.filter { $0 == "state:connected" }.count == 3)
    }
  }

  @Test func fixtureCleansUpAfterThrownFailureWithHeldToken() async throws {
    enum ExpectedFailure: Error { case fixture }
    var gate: SocketTokenGate?
    do {
      try await withSocketLifetimeFixture { fixture in
        gate = fixture.gate
        await fixture.socket(heldToken: true).connect()
        try await fixture.gate.log.waitFor("entered")
        throw ExpectedFailure.fixture
      }
      Issue.record("Expected the body failure to propagate")
    } catch ExpectedFailure.fixture {
      #expect(gate?.log.values.contains("returned") == true)
    }
  }

  static func event(_ id: Int) -> String {
    #"{"type":"pod.status_changed","timestamp":"2026-10-15T00:00:00Z","_eventId":\#(id),"podId":"socket-fixture","previousStatus":"running","newStatus":"paused"}"#
  }
}
