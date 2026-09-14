import Foundation
import Testing
@testable import AutopodClient

@Test func nativeGoalCountersAndControlRevision() throws {
  let data = Data(#"{"podId":"pod","objective":"Tests pass","state":"paused","revision":7,"runtime":"codex","nativeSessionId":"native","nativeStatus":"paused","executionStopped":true,"controlIntent":null,"observedTokens":345,"observedSeconds":12.5,"reason":null,"createdAt":"2026-09-14","updatedAt":"2026-09-14"}"#.utf8)
  let goal = try JSONDecoder().decode(PodGoalResponse.self, from: data)
  #expect(goal.observedTokens == 345)
  #expect(goal.observedSeconds == 12.5)
  #expect(goal.executionStopped)
  let request = PodGoalControlRequest(revision: goal.revision, intent: "resume")
  let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
  #expect(encoded?["revision"] as? Int == 7)
  #expect(encoded?["intent"] as? String == "resume")
  #expect(encoded?.count == 2)
}
