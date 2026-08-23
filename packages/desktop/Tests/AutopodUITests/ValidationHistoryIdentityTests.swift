import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Suite("ValidationHistoryIdentityTests")
struct ValidationHistoryIdentityTests {
  @Test func repeatedAttemptsUseImmutableHistoryIdentity() throws {
    let history = try JSONDecoder().decode(
      [StoredValidationResponse].self,
      from: """
      [
        \(storedValidationJson(id: "validation-1", attempt: 1, sequence: 1, cycle: 0, overall: "fail")),
        \(storedValidationJson(id: "validation-2", attempt: 2, sequence: 2, cycle: 0, overall: "pass")),
        \(storedValidationJson(id: "validation-3", attempt: 1, sequence: 3, cycle: 1, overall: "fail"))
      ]
      """.data(using: .utf8)!
    )

    #expect(history.map(\.sequence) == [1, 2, 3])
    #expect(history.map(\.cycle) == [0, 0, 1])

    let sorted = sortedValidationHistory(history)
    #expect(sorted.map(\.id) == ["validation-3", "validation-2", "validation-1"])
    #expect(Set(sorted.map(validationHistoryLabel)).count == 3)
    #expect(validationHistoryLabel(sorted[0]) == "Run 3 · Cycle 2 · Attempt 1 · fail")

    #expect(selectedValidationHistory(key: "validation-3", in: history)?.id == "validation-3")
    #expect(selectedValidationHistory(key: "validation-1", in: history)?.id == "validation-1")
    #expect(selectedValidationHistory(key: "current", in: history) == nil)
  }

  @Test func reworkAndWorkerExecutionHaveDistinctLabels() throws {
    let attempts = AttemptInfo(
      current: 0,
      max: 7,
      reworkCount: 6,
      workerExecution: WorkerExecutionSummary(
        totalRuns: 7,
        completed: 3,
        didNotStart: 3,
        interrupted: 1,
        active: 0
      )
    )

    #expect(validationAttemptLabel(attempts) == "Rework cycle 6 — Validation 0 of 7")
    #expect(
      workerExecutionLabel(attempts.workerExecution)
        == "Workers: 3 completed · 3 did not start · 1 interrupted"
    )
  }
}

private func storedValidationJson(
  id: String,
  attempt: Int,
  sequence: Int,
  cycle: Int,
  overall: String
) -> String {
  """
  {
    "id": "\(id)",
    "podId": "history-pod",
    "attempt": \(attempt),
    "sequence": \(sequence),
    "cycle": \(cycle),
    "createdAt": "2026-08-23T12:00:0\(sequence).000Z",
    "result": {
      "podId": "history-pod",
      "attempt": \(attempt),
      "timestamp": "2026-08-23T12:00:0\(sequence).000Z",
      "smoke": {
        "status": "pass",
        "build": { "status": "pass", "output": "", "duration": 10 },
        "health": {
          "status": "pass",
          "url": "http://localhost:3000",
          "responseCode": 200,
          "duration": 5
        },
        "pages": []
      },
      "taskReview": null,
      "overall": "\(overall)",
      "duration": 20
    }
  }
  """
}
