import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func validationHistoryRefreshesSelectedStaleAttemptAfterAdvisoryCompletion() throws {
  let staleHistory = try storedValidation(advisoryBrowserQa: "null")
  var progress = ValidationProgress.initial(attempt: 1)
  progress.markStarted(.advisory)

  #expect(
    validationHistoryShouldRefreshAfterAdvisory(
      selectedHistory: staleHistory,
      progress: progress
    ) == false
  )

  progress.markCompleted(.advisory, result: try advisoryPhaseResult())

  #expect(
    validationHistoryShouldRefreshAfterAdvisory(
      selectedHistory: staleHistory,
      progress: progress
    ) == true
  )
}

@Test func validationHistoryDoesNotRefreshCurrentOrAlreadyEnrichedAttempt() throws {
  var progress = ValidationProgress.initial(attempt: 1)
  progress.markStarted(.advisory)
  progress.markCompleted(.advisory, result: try advisoryPhaseResult())

  #expect(
    validationHistoryShouldRefreshAfterAdvisory(
      selectedHistory: nil,
      progress: progress
    ) == false
  )
  #expect(
    validationHistoryShouldRefreshAfterAdvisory(
      selectedHistory: try storedValidation(advisoryBrowserQa: advisoryBrowserQaJson),
      progress: progress
    ) == false
  )
}

private func advisoryPhaseResult() throws -> ValidationPhaseResult {
  let raw = try JSONDecoder().decode(
    RawSystemEvent.self,
    from: """
    {
      "type": "pod.validation_phase_completed",
      "timestamp": "2026-06-01T12:00:00.000Z",
      "podId": "history-pod",
      "phase": "advisory",
      "phaseStatus": "fail",
      "advisoryResult": \(advisoryBrowserQaJson)
    }
    """.data(using: .utf8)!
  )
  return ValidationPhaseResult(from: raw)
}

private func storedValidation(advisoryBrowserQa: String) throws -> StoredValidationResponse {
  try JSONDecoder().decode(
    StoredValidationResponse.self,
    from: """
    {
      "id": "validation-1",
      "podId": "history-pod",
      "attempt": 1,
      "createdAt": "2026-06-01T12:00:00.000Z",
      "result": {
        "podId": "history-pod",
        "attempt": 1,
        "timestamp": "2026-06-01T12:00:00.000Z",
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
        "advisoryBrowserQa": \(advisoryBrowserQa),
        "overall": "pass",
        "duration": 20
      }
    }
    """.data(using: .utf8)!
  )
}

private let advisoryBrowserQaJson = """
{
  "status": "fail",
  "reasoning": "Advisory issue persisted after blocking validation.",
  "durationMs": 42,
  "observations": [],
  "screenshots": []
}
"""
