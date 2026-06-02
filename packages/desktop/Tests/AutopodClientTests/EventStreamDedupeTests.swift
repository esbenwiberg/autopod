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
        timestamp: base.addingTimeInterval(1),
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
}
