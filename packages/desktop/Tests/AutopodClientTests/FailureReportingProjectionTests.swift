import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@Suite @MainActor struct FailureReportingProjectionTests {
  let saved = "  Recorded failure\n" + String(repeating: "long detail ", count: 70) + "\nTAIL-SENTINEL  \n"

  @Test func compactHydrationFreshnessAndReplacement() async throws {
    try await withPodStoreLifetimeFixture { f in
      @MainActor func discover(_ stamp: String) async throws {
        let task = f.start { await f.store.loadSessions() }
        let page = lifetimePage(id: "residential-cod", hasNext: false, status: "failed", updatedAt: stamp)
          .replacingOccurrences(of: "\"failureReason\":null", with: "\"failureReason\":\"Compact preview only\"")
        try await f.next(f.a, "/pods").respond(body: page)
        try await f.next(f.a, "/pods/scores").respond(body: "[]")
        _ = await task.value
      }
      @MainActor func hydrate(_ stamp: String, reason: String?) async throws {
        let task = f.start { await f.store.refreshSession("residential-cod") }
        try await f.next(f.a, "/pods/residential-cod").respond(body: failurePod(stamp: stamp, reason: reason))
        _ = await task.value
      }
      let first = "2026-07-01T00:10:00Z"
      let newer = "2026-07-01T00:20:00Z"
      try await discover(first)
      #expect(f.store.pods.first?.currentFailureDetail == nil)
      try await hydrate(first, reason: saved)
      #expect(f.store.pods.first?.recordedFailureReason == saved)
      try await discover(first)
      try await discover("2026-07-01T00:00:00Z")
      #expect(f.store.pods.first?.recordedFailureReason == saved)
      // Reconfiguration of the same source invalidates hydration, retaining data.
      // Equal/older compact discovery now takes mergeRestPod, not mergeCompactPod.
      f.store.configure(api: f.apiA)
      try await discover(first)
      try await discover("2026-07-01T00:00:00Z")
      #expect(f.store.pods.first?.recordedFailureReason == saved)
      f.store.setError("residential-cod", summary: "socket error")
      #expect(f.store.pods.first?.recordedFailureReason == saved)
      try await discover(newer)
      #expect(f.store.pods.first?.currentFailureDetail == nil)
      let delayed = f.start { await f.store.refreshSession("residential-cod") }
      let request = try await f.next(f.a, "/pods/residential-cod")
      #expect(f.store.pods.first?.recordedFailureReason == nil)
      request.respond(status: 500, body: "{}")
      _ = await delayed.value
      #expect(f.store.pods.first?.currentFailureDetail == nil)
      try await hydrate(first, reason: saved) // stale REST cannot revive old detail
      #expect(f.store.pods.first?.currentFailureDetail == nil)
      try await hydrate(newer, reason: "replacement\n ")
      #expect(f.store.pods.first?.recordedFailureReason == "replacement\n ")
      try await hydrate(newer, reason: nil)
      #expect(f.store.pods.first?.currentFailureDetail != nil)
      #expect(f.store.pods.first?.recordedFailureReason == nil)
      let racing = f.start { await f.store.refreshSession("residential-cod") }
      let stale = try await f.next(f.a, "/pods/residential-cod")
      f.store.updateStatus("residential-cod", to: .running)
      stale.respond(body: try failurePod(stamp: newer, reason: saved))
      _ = await racing.value
      #expect(f.store.pods.first?.recordedFailureReason == nil)
      #expect(f.store.pods.first?.status == .running)
      let priorAttempt = f.start { await f.store.refreshSession("residential-cod") }
      let priorRequest = try await f.next(f.a, "/pods/residential-cod")
      f.store.removeSession("residential-cod")
      f.seed("residential-cod")
      priorRequest.respond(body: try failurePod(stamp: newer, reason: saved))
      _ = await priorAttempt.value
      #expect(f.store.pods.first?.recordedFailureReason == nil)
      f.store.removeSession("residential-cod")
      f.seed("another-pod")
      #expect(f.store.pods.first?.failureDetail == nil)
    }
  }

  @Test func fullMappingAndCurrentTypedCauses() throws {
    for (code, expected) in [
      ("", "Test failed"), ("VALIDATION_RUNNER_CRASHED", "Test runner crashed"),
      ("PROCESS_MEMORY_EXHAUSTED", "Test process memory exhausted"),
      ("SANDBOX_MEMORY_EXHAUSTED", "Test process memory exhausted"),
      ("PROCESS_KILLED", "Test process killed"), ("TIMEOUT", "Test timed out")
    ] {
      let pod = try mapped(reason: saved, code: code)
      #expect(pod.recordedFailureReason == saved)
      #expect(pod.failureOverviewTitle == expected)
      let review = try mapped(reason: saved, code: code, status: "review_required")
      #expect(review.failureOverviewTitle == expected)
    }
  }

  @Test func oldSkippedAdvisoryAndKilledNeverClaimTestFailure() throws {
    for reason in [nil, saved] {
      let killed = try mapped(reason: reason, code: "", status: "killed", attempt: 9)
      #expect(killed.failureOverviewTitle == nil)
      #expect(killed.recordedFailureReason == reason)
    }
    #expect(try mapped(reason: nil, code: "", attempt: 9).failureOverviewTitle == nil)
    #expect(try mapped(reason: nil, code: "", timestamp: "2026-06-01T00:00:00Z").failureOverviewTitle == nil)
    #expect(try mapped(reason: nil, code: "", testStatus: "skip").failureOverviewTitle == nil)
    #expect(try mapped(reason: "Agent failed: exited 137", code: "").failureOverviewTitle == "Agent failed")
  }

  private func mapped(reason: String?, code: String, status: String = "failed", attempt: Int = 1,
                      timestamp: String = "2026-07-01T00:05:00Z", testStatus: String = "fail") throws -> Pod {
    var body = try failureBody(stamp: "2026-07-01T00:10:00Z", reason: reason)
    body["status"] = status
    body["runningAt"] = "2026-07-01T00:01:00Z"
    var validation: [String: Any] = [
      "podId": "residential-cod", "attempt": attempt, "timestamp": timestamp, "overall": "fail", "duration": 1,
      "smoke": ["status": "skip", "build": ["status": "skip", "output": "", "duration": 0],
                "health": ["status": "skip", "url": "", "duration": 0], "pages": []],
      "test": ["status": testStatus, "duration": 1],
      "advisoryBrowserQa": ["status": "fail", "reasoning": "advisory only", "observations": [], "screenshots": []]
    ]
    if !code.isEmpty {
      var failure: [String: Any] = ["phase": "test", "code": code, "message": "infrastructure", "retryable": false]
      if code == "TIMEOUT" { failure["execution"] = ["cause": "timeout", "cleanup": "confirmed"] }
      validation["infrastructureFailure"] = failure
    }
    body["lastValidationResult"] = validation
    return PodMapper.map(try JSONDecoder().decode(SessionResponse.self, from: JSONSerialization.data(withJSONObject: body)))
  }
}

private func failureBody(stamp: String, reason: String?) throws -> [String: Any] {
  var body = try #require(JSONSerialization.jsonObject(with: Data(lifetimePod(id: "residential-cod").utf8)) as? [String: Any])
  body["status"] = "failed"
  body["updatedAt"] = stamp
  body["failureReason"] = reason.map { $0 as Any } ?? NSNull()
  return body
}

private func failurePod(stamp: String, reason: String?) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: failureBody(stamp: stamp, reason: reason)), as: UTF8.self)
}
