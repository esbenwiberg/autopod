import Testing
@testable import AutopodClient

@Suite("EventSocket control messages")
struct EventSocketControlMessageTests {
  @Test func replayTruncationRequestsRestResync() throws {
    let message = EventSocket.decodeIncomingMessage(
      """
      {
        "type": "replay_truncated",
        "resumeFromEventId": 12345,
        "reason": "too_many_events"
      }
      """
    )

    guard case .resyncRequired = message else {
      Issue.record("Expected replay truncation to request a REST resync")
      return
    }
  }
}
