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
  #expect(response.resourceCost == nil)
  #expect(response.totalLabel == "Known total")
}

@Test func sandboxResourceCostDecodingAndPresentation() throws {
  for state in ["estimated", "partial", "unavailable", "future-state"] {
    let json = """
    {"podId":"automatic-mackerel","model":"gpt-6.1-sol","totalCostUsd":3.19,
     "inputTokens":21400000,"outputTokens":57000,"segments":[],
     "resourceCost":{"state":"\(state)","estimateUsd":0.018,"observationCutoff":"2026-11-21T12:00:00Z"}}
    """.data(using: .utf8)!
    let response = try JSONDecoder().decode(PodCostBreakdownResponse.self, from: json)
    let usable = state == "estimated" || state == "partial"
    #expect(abs(response.combinedCostUsd - (usable ? 3.208 : 3.19)) < 0.0000001)
    #expect(response.totalLabel == (state == "estimated" ? "Estimated total" : "Known total"))
    #expect(response.resourceCost?.qualifier == (state == "partial" ? "partial est." : "est."))
    #expect((response.resourceCost?.usableEstimate != nil) == usable)
  }
  let unavailable = PodResourceCost(state: "unavailable", estimateUsd: nil, observationCutoff: nil)
  #expect(unavailable.usableEstimate == nil)
  let unknownModel = PodCostBreakdownResponse(podId: "automatic-mackerel", model: nil,
    totalCostUsd: 1, inputTokens: 20, outputTokens: 0,
    segments: [PodCostSegment(bucket: "work", label: "Work", costUsd: 0, inputTokens: 20,
      outputTokens: 0, sourcePhases: [], attribution: "unavailable")],
    resourceCost: PodResourceCost(state: "estimated", estimateUsd: 0.018, observationCutoff: nil))
  #expect(unknownModel.totalLabel == "Known total")
  let unreadable = """
  {"podId":"automatic-mackerel","model":"test","totalCostUsd":0,"inputTokens":20,"outputTokens":0,"segments":[],
   "resourceCost":{"state":"estimated","estimateUsd":0.018,"observationCutoff":null},
   "costEvidence":{"basis":"stored_subtotal","billingVerified":false,"knownEstimatedCostUsd":0,
    "unavailablePhaseCount":0,"conflictingPodCount":0,"omittedDiagnosticCount":0,
    "diagnostics":[{"podId":"automatic-mackerel","code":"AGENT_COST_UNAVAILABLE","message":"Missing model cost"}]}}
  """.data(using: .utf8)!
  #expect(try JSONDecoder().decode(PodCostBreakdownResponse.self, from: unreadable).totalLabel == "Known total")
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
    "diagnostics": ["1 deleted pod record retains task accounting and execution evidence.", "1 unsettled worker run blocks another task run; live execution state unverified.", "Oldest unsettled run resource ownership unavailable; current pod resource is not historical evidence."],
    "merge": { "closedPrCount": 1, "prCount": 3, "requestCount": 3, "mergedPrCount": 1, "mergedWithoutRecordedRequestCount": 1, "unresolvedPrCount": 1, "scope": "source-bound-journal-only", "basis": "last-recorded", "liveVerified": false },
    "budgetCheck": { "status": "unavailable", "reason": "Task token accounting incomplete; reconcile prior execution telemetry." }
  }
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(TaskExecutionSummary.self, from: json)
  #expect(response.diagnostics.contains("1 deleted pod record retains task accounting and execution evidence."))
  #expect(response.diagnostics[1] == "1 unsettled worker run blocks another task run; live execution state unverified.")
  #expect(response.diagnostics.last?.contains("current pod resource is not historical evidence") == true)
  #expect(response.recordedInputTokens + response.recordedOutputTokens == 15)
  #expect(response.tokenBudget == 100)
  #expect(response.merge?.requestCount == 3)
  #expect(response.merge?.closedPrCount == 1)
  #expect(response.merge?.mergedPrCount == 1)
  #expect(response.merge?.mergedWithoutRecordedRequestCount == 1)
  #expect(response.merge?.liveVerified == false)
  #expect(response.budgetCheck?.status == "unavailable")
  #expect(response.budgetCheck?.reason.contains("reconcile prior execution telemetry") == true)
  var legacy = try #require(JSONSerialization.jsonObject(with: json) as? [String: Any])
  var olderMerge = try #require(legacy["merge"] as? [String: Any])
  olderMerge.removeValue(forKey: "closedPrCount")
  legacy["merge"] = olderMerge
  let olderMergeResponse = try JSONDecoder().decode(TaskExecutionSummary.self, from: JSONSerialization.data(withJSONObject: legacy))
  #expect(olderMergeResponse.merge?.mergedPrCount == 1)
  #expect(olderMergeResponse.merge?.closedPrCount == nil)
  legacy.removeValue(forKey: "budgetCheck")
  legacy.removeValue(forKey: "merge")
  let old = try JSONDecoder().decode(TaskExecutionSummary.self, from: JSONSerialization.data(withJSONObject: legacy))
  #expect(old.budgetCheck == nil)
  #expect(old.merge == nil)
}

@Test func costEvidenceRetainsEstimatesAndConflictingStoredAmounts() throws {
  let json = """
  {"podId":"root","model":"worker","totalCostUsd":2,"inputTokens":10,"outputTokens":2,
   "segments":[{"bucket":"work","label":"Work","costUsd":0,"storedCostUsd":3,"attribution":"unavailable","inputTokens":10,"outputTokens":2,"sourcePhases":["agent_initial"]}],
   "costEvidence":{"basis":"stored_subtotal","billingVerified":false,"knownEstimatedCostUsd":0.5,"unavailablePhaseCount":1,"conflictingPodCount":1,"omittedDiagnosticCount":2,
   "diagnostics":[{"podId":"root","code":"PHASE_COST_CONFLICT","message":"No proportional allocation applied."}]}}
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(PodCostBreakdownResponse.self, from: json)
  #expect(response.costEvidence?.billingVerified == false)
  #expect(response.costEvidence?.knownEstimatedCostUsd == 0.5)
  #expect(response.costEvidence?.conflictingPodCount == 1)
  #expect(response.costEvidence?.omittedDiagnosticCount == 2)
  #expect(response.segments[0].storedCostUsd == 3)
  #expect(response.segments[0].attribution == "unavailable")
  let roundTrip = try JSONDecoder().decode(PodCostBreakdownResponse.self, from: JSONEncoder().encode(response))
  #expect(roundTrip == response)
}

@Test func taskDeliveryDispositionRetainsStoredEvidenceAndMissingLegacyStatus() throws {
  let json = #"{"intentCount":3,"receiptCount":2,"unresolvedCount":1,"scope":"durable-receipts-only","disposition":{"openCount":0,"mergedCount":1,"closedCount":0,"unavailableCount":1,"basis":"last-recorded","liveVerified":false}}"#.data(using: .utf8)!
  let response = try JSONDecoder().decode(TaskDeliverySummaryResponse.self, from: json)
  #expect(response.receiptCount == 2)
  #expect(response.disposition?.mergedCount == 1)
  #expect(response.disposition?.unavailableCount == 1)
  #expect(response.disposition?.basis == "last-recorded")
  #expect(response.disposition?.liveVerified == false)
  let roundTrip = try JSONDecoder().decode(TaskDeliverySummaryResponse.self, from: JSONEncoder().encode(response))
  #expect(roundTrip == response)
  var legacy = try #require(JSONSerialization.jsonObject(with: json) as? [String: Any])
  legacy.removeValue(forKey: "disposition")
  let old = try JSONDecoder().decode(TaskDeliverySummaryResponse.self, from: JSONSerialization.data(withJSONObject: legacy))
  #expect(old.receiptCount == 2)
  #expect(old.disposition == nil)
}
