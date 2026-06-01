import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func validationProgressCompletesAdvisoryFailureFromPhaseEvent() throws {
  var progress = ValidationProgress.initial(attempt: 1)
  #expect(progress.hasRunningPhase == false)
  progress.markStarted(.advisory)
  #expect(progress.hasRunningPhase == true)

  let raw = try JSONDecoder().decode(
    RawSystemEvent.self,
    from: """
    {
      "type": "pod.validation_phase_completed",
      "timestamp": "2026-05-26T20:08:38.926Z",
      "podId": "intelligent-eagle",
      "phase": "advisory",
      "phaseStatus": "fail",
      "advisoryResult": {
        "status": "fail",
        "reasoning": "Help modal did not open.",
        "model": "claude-sonnet-4-6",
        "durationMs": 41845,
        "observations": [],
        "screenshots": []
      }
    }
    """.data(using: .utf8)!
  )

  progress.markCompleted(.advisory, result: ValidationPhaseResult(from: raw))

  #expect(progress.advisory.status == .failed)
  #expect(progress.activePhase == nil)
  #expect(progress.hasRunningPhase == false)
  #expect(progress.advisoryDetail?.status == "fail")
  #expect(progress.advisoryDetail?.durationMs == 41845)
}

@Test func validationProgressCompletesSetupFailureFromPhaseEvent() throws {
  var progress = ValidationProgress.initial(attempt: 1)
  #expect(progress.state(for: .setup).status == .notStarted)
  #expect(progress.hasRunningPhase == false)

  progress.markStarted(.setup)
  #expect(progress.activePhase == .setup)
  #expect(progress.hasRunningPhase == true)

  let raw = try JSONDecoder().decode(
    RawSystemEvent.self,
    from: """
    {
      "type": "pod.validation_phase_completed",
      "timestamp": "2026-06-01T12:00:00.000Z",
      "podId": "fond-sturgeon",
      "phase": "setup",
      "phaseStatus": "fail",
      "setupResult": {
        "status": "fail",
        "output": "pip install -e .",
        "duration": 987,
        "error": "ruff not found"
      }
    }
    """.data(using: .utf8)!
  )

  progress.markCompleted(.setup, result: ValidationPhaseResult(from: raw))

  #expect(progress.setup.status == .failed)
  #expect(progress.setup.duration == 987)
  #expect(progress.setupOutput == "pip install -e .\nruff not found")
  #expect(progress.lint.status == .skipped)
  #expect(progress.build.status == .skipped)
  #expect(progress.review.status == .skipped)
  #expect(progress.activePhase == nil)
  #expect(progress.hasRunningPhase == false)
}
