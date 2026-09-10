import Foundation
import Testing
@testable import AutopodClient

@Test(arguments: [false, true])
func retryDurationEvidenceRemainsUnavailableWhenMissing(legacy: Bool) throws {
  var value: [String: Any] = ["taskId": "task", "stage": "worker", "backoffsMs": [],
    "admissionCount": 1, "executedCount": 1, "transientRetryCount": 0,
    "measuredDurationMs": legacy ? 0 : NSNull(), "interruptedCount": 0,
    "authorizations": [], "telemetry": "partial"]
  if !legacy {
    value["durationEvidence"] = ["measuredRecordCount": 0, "unavailableRecordCount": 1,
      "pendingRecordCount": 0, "basis": "stage_elapsed_subtotal", "additiveAcrossStages": false]
  }
  let state = try JSONDecoder().decode(TaskRetryState.self, from: JSONSerialization.data(withJSONObject: value))
  #expect(state.durationEvidenceDescription.contains(legacy ? "Duration coverage unavailable from this daemon." : "1 records without duration"))
  #expect(state.durationEvidenceDescription.contains("Stage durations can overlap; do not add them."))
  #expect(state.measuredDurationDescription == (legacy ? "0 ms measured" : "Measured duration unavailable"))
}
