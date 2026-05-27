import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func validationProgressCompletesAdvisoryFailureFromPhaseEvent() throws {
  var progress = ValidationProgress.initial(attempt: 1)
  progress.markStarted(.advisory)

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
  #expect(progress.advisoryDetail?.status == "fail")
  #expect(progress.advisoryDetail?.durationMs == 41845)
}
