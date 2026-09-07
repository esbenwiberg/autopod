import Foundation
import Testing
@testable import AutopodClient

@Test func podCostBreakdownResponseDecodesRoundTrip() throws {
  let json = """
  {
    "podId": "pod-cost-1",
    "model": "gpt-5",
    "totalCostUsd": 10.0,
    "inputTokens": 3000000,
    "outputTokens": 500000,
    "segments": [
      {
        "bucket": "work",
        "label": "Work",
        "costUsd": 1.25,
        "inputTokens": 1000000,
        "outputTokens": 0,
        "sourcePhases": ["agent_initial"]
      },
      {
        "bucket": "validation",
        "label": "Validation",
        "costUsd": 2.5,
        "inputTokens": 2000000,
        "outputTokens": 0,
        "sourcePhases": ["review", "plan_eval"]
      }
    ]
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(PodCostBreakdownResponse.self, from: json)

  #expect(response.podId == "pod-cost-1")
  #expect(response.model == "gpt-5")
  #expect(response.totalCostUsd == 10.0)
  #expect(response.inputTokens == 3_000_000)
  #expect(response.outputTokens == 500_000)
  #expect(response.segments.count == 2)
  #expect(response.segments[0].bucket == "work")
  #expect(response.segments[0].id == "work")
  #expect(response.segments[1].sourcePhases == ["review", "plan_eval"])
}

@Test func podCostBreakdownResponseDecodesNullModel() throws {
  let json = """
  {
    "podId": "legacy-pod",
    "model": null,
    "totalCostUsd": 0,
    "inputTokens": 0,
    "outputTokens": 0,
    "segments": []
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(PodCostBreakdownResponse.self, from: json)
  #expect(response.model == nil)
  #expect(response.segments.isEmpty)
}

@Test func taskAccountingRetainsUnavailableBudgetAdmission() throws {
  let json = """
  {
    "taskId": "task:root", "executionId": "execution:fix", "rootPodId": "root",
    "podCount": 2, "agentRunCount": 1, "failedRunCount": 1, "transientFailureCount": 0,
    "providerAttemptCount": 1, "validationExecutionCount": 0,
    "tokenBudget": 100, "recordedInputTokens": 10, "recordedOutputTokens": 5,
    "recordedCostUsd": 0.5, "infrastructureCostUsd": null, "telemetry": "partial",
    "diagnostics": [],
    "budgetCheck": { "status": "unavailable", "reason": "Task token accounting incomplete; reconcile prior execution telemetry." }
  }
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(TaskExecutionSummary.self, from: json)
  #expect(response.recordedInputTokens + response.recordedOutputTokens == 15)
  #expect(response.tokenBudget == 100)
  #expect(response.budgetCheck?.status == "unavailable")
  #expect(response.budgetCheck?.reason.contains("reconcile prior execution telemetry") == true)
  var legacy = try #require(JSONSerialization.jsonObject(with: json) as? [String: Any])
  legacy.removeValue(forKey: "budgetCheck")
  let old = try JSONDecoder().decode(TaskExecutionSummary.self, from: JSONSerialization.data(withJSONObject: legacy))
  #expect(old.budgetCheck == nil)
}
