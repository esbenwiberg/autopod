import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func validationProgressTracksEstimatedWaitThenReturnsToIndeterminate() throws {
  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data("""
    {"type":"pod.validation_phase_started","podId":"worker","phase":"test","timestamp":"2026-06-01T12:00:00Z","estimate":{"durationMs":300000,"sampleCount":1}}
    """.utf8))
  guard case .validationPhaseStarted(_, .test, let timestamp, let estimate) = SystemEvent.parse(raw) else {
    Issue.record("Missing test start")
    return
  }
  #expect(timestamp == raw.timestamp)
  let started = Date(timeIntervalSince1970: 1_000)
  let timing = ValidationPhaseTiming(startedAt: started, estimate: estimate)
  var progress = ValidationProgress.initial(attempt: 1)
  let acceptedStart = progress.advancePhaseEvent(20)
  #expect(acceptedStart)
  progress.markStarted(.test, timing: timing)
  let acceptedStaleEvent = progress.advancePhaseEvent(19)
  #expect(!acceptedStaleEvent)
  #expect(validationShouldDisplayLiveProgress(podStatus: .validating, progress: progress, hasPersistedReviewCouncil: true))

  let now = started.addingTimeInterval(134)
  let predicted = ValidationPhaseClock(timing: progress.activePhaseTiming, now: now)
  #expect(predicted.label == "~3m left")
  #expect(predicted.fraction == 134.0 / 300)
  #expect(predicted.detail == "2m 14s elapsed · ~3m left (last run: 5m)")

  let late = ValidationPhaseClock(timing: timing, now: started.addingTimeInterval(370))
  #expect(late.fraction == nil)
  #expect(late.label == "6m 10s elapsed")
  #expect(late.detail.contains("over estimate"))
  #expect(ValidationPhaseClock(timing: timing, now: started.addingTimeInterval(300)).fraction == nil)

  let firstRun = ValidationPhaseClock(timing: ValidationPhaseTiming(startedAt: started), now: now)
  #expect(firstRun.label == "2m 14s elapsed")
  #expect(firstRun.fraction == nil)
  #expect(ValidationPhaseClock(timing: nil, now: now).label == "Running")

  progress.markStarted(.health)
  #expect(progress.test.status == .notStarted)
  #expect(progress.activePhase == .health)
  #expect(progress.activePhaseTiming == nil)
}

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

@Test func validationProgressPropagatesLiveReviewCouncil() throws {
  var progress = ValidationProgress.initial(attempt: 2)
  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: """
  {"type":"pod.validation_phase_completed","timestamp":"2026-08-04T00:00:00Z","podId":"lonely-panther","phase":"review","phaseStatus":"fail","reviewResult":{"status":"fail","reasoning":"x","issues":[],"model":"m","screenshots":[],"diff":"","reviewBatch":{"id":"live-packet","diffHash":"d","reviewedHead":"h","promptVersion":"p","schemaVersion":"s","model":"m","axes":[{"axis":"security_authority","status":"unavailable","attempts":1,"error":"Network unavailable"}],"candidates":[],"initialFindings":[],"accepted":[],"rejected":[],"merged":[],"synthesis":"model","durationMs":5,"infrastructureUnavailable":true}}}
  """.data(using: .utf8)!)
  progress.markCompleted(.review, result: ValidationPhaseResult(from: raw))
  #expect(progress.reviewDetail?.council?.id == "live-packet")
  #expect(progress.review.status == .failed)
  #expect(reviewPhasePresentation(progress: progress, checks: nil, council: progress.reviewDetail?.council).status == .failed)
  #expect(progress.reviewDetail?.council?.axes.first?.error == "Network unavailable")
  #expect(validationShouldDisplayLiveProgress(podStatus: .complete, progress: progress, hasPersistedReviewCouncil: false))
  #expect(!validationShouldDisplayLiveProgress(podStatus: .complete, progress: progress, hasPersistedReviewCouncil: true))
}

@Test func liveReviewProgressUsesSettledNotCompletedForUnavailableAxes() {
  let started = Date(timeIntervalSince1970: 1_000)
  let progress = LiveReviewProgress(
    attempt: 1,
    startedAt: started,
    updatedAt: started.addingTimeInterval(82),
    elapsedMs: 82_000,
    guardrailMs: 300_000,
    stage: .axes,
    axes: [
      LiveReviewAxis(axis: "contract_completeness", status: .completed, attempt: 1),
      LiveReviewAxis(axis: "security_authority", status: .unavailable, attempt: 2),
      LiveReviewAxis(axis: "lifecycle_reliability", status: .completed, attempt: 1),
      LiveReviewAxis(axis: "persistence_reproducibility", status: .running, attempt: 1),
      LiveReviewAxis(axis: "tests_integration", status: .queued, attempt: 0),
    ]
  )
  let presentation = liveReviewProgressPresentation(
    progress,
    at: started.addingTimeInterval(82)
  )

  #expect(progress.settledCount == 3)
  #expect(progress.completedCount == 2)
  #expect(presentation.headline == "3/5 settled")
  #expect(presentation.timing == "1m 22s / 5m guardrail")
  #expect(!presentation.headline.contains("complete"))
}
