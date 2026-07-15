import Foundation
import Testing
@testable import AutopodDesktop
@testable import AutopodUI

@Suite("EventStreamDedupeTests")
struct EventStreamDedupeTests {
  @Test func mergesHistoricalAndLiveEventsByServerId() {
    let base = Date(timeIntervalSince1970: 1_800_000_000)
    let historical = [
      AgentEvent(id: 41, timestamp: base, type: .status, summary: "Creating worktree")
    ]
    let live = [
      AgentEvent(id: 41, timestamp: base, type: .status, summary: "Creating worktree"),
      AgentEvent(
        id: 42,
        timestamp: base.addingTimeInterval(-1),
        type: .status,
        summary: "Running security scan"
      ),
    ]

    let merged = EventStream.mergeHistoricalAndLiveEvents(historical: historical, live: live)

    #expect(merged.map(\.id) == [41, 42])
    #expect(merged.map(\.summary) == ["Creating worktree", "Running security scan"])
  }

  @Test func appendsPendingEventsWithoutDuplicatingIds() {
    let base = Date(timeIntervalSince1970: 1_800_000_000)
    let existing = [
      AgentEvent(id: 10, timestamp: base, type: .status, summary: "Spawning container")
    ]
    let incoming = [
      AgentEvent(id: 10, timestamp: base, type: .status, summary: "Spawning container"),
      AgentEvent(
        id: 11,
        timestamp: base.addingTimeInterval(1),
        type: .status,
        summary: "Populating workspace"
      ),
    ]

    let result = EventStream.appendDeduped(existing, incoming)

    #expect(result.map(\.id) == [10, 11])
  }

  @Test func ordersInterleavedPendingEventsByPersistedId() {
    let base = Date(timeIntervalSince1970: 1_800_000_000)
    let existing = [
      AgentEvent(id: 10, timestamp: base, type: .status, summary: "Earlier"),
      AgentEvent(
        id: 12,
        timestamp: base.addingTimeInterval(2),
        type: .status,
        summary: "Later"
      ),
    ]
    let incoming = [
      AgentEvent(
        id: 11,
        timestamp: base.addingTimeInterval(1),
        type: .error,
        summary: "Delayed warning"
      ),
      AgentEvent(id: 12, timestamp: base, type: .status, summary: "Duplicate later"),
    ]

    let result = EventStream.appendDeduped(existing, incoming)

    #expect(result.map(\.id) == [10, 11, 12])
    #expect(result.map(\.summary) == ["Earlier", "Delayed warning", "Later"])
  }

  @Test func ordersLegacyFallbackIdsByTimestamp() {
    let base = Date(timeIntervalSince1970: 1_800_000_000)
    let existing = [
      AgentEvent(
        id: -2,
        timestamp: base.addingTimeInterval(2),
        type: .status,
        summary: "Legacy later"
      )
    ]
    let incoming = [
      AgentEvent(id: 20, timestamp: base, type: .status, summary: "Persisted earlier"),
      AgentEvent(
        id: -1,
        timestamp: base.addingTimeInterval(1),
        type: .status,
        summary: "Legacy middle"
      ),
    ]

    let result = EventStream.appendDeduped(existing, incoming)

    #expect(result.map(\.id) == [20, -1, -2])
  }
}
