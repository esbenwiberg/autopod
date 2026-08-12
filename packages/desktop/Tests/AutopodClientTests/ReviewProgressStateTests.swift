import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

private let reviewProgressJSON = """
{
  "type": "pod.review_progress",
  "timestamp": "2026-08-11T16:48:14Z",
  "podId": "steady-lobster",
  "progress": {
    "attempt": 2,
    "startedAt": "2026-08-11T16:46:52Z",
    "updatedAt": "2026-08-11T16:48:14Z",
    "elapsedMs": 82000,
    "guardrailMs": 300000,
    "stage": "axes",
    "axes": [
      {"axis":"contract_completeness","status":"completed","attempt":1,"durationMs":72000},
      {"axis":"security_authority","status":"unavailable","attempt":2,"failureKind":"provider-unavailable"},
      {"axis":"lifecycle_reliability","status":"completed","attempt":1,"durationMs":83000},
      {"axis":"persistence_reproducibility","status":"running","attempt":1},
      {"axis":"tests_integration","status":"queued","attempt":0}
    ]
  }
}
"""

@Test func reviewProgressEventDecodesAndMapsSettledSemantics() throws {
  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data(reviewProgressJSON.utf8))
  guard case .reviewProgress(let podId, let response) = SystemEvent.parse(raw) else {
    Issue.record("Expected a typed review-progress event")
    return
  }
  let progress = try #require(PodMapper.mapReviewProgress(response))

  #expect(podId == "steady-lobster")
  #expect(progress.axes.map(\.displayName) == [
    "Contract", "Security", "Reliability", "Persistence", "Tests",
  ])
  #expect(progress.settledCount == 3)
  #expect(progress.completedCount == 2)
  #expect(progress.unavailableCount == 1)
  #expect(progress.runningCount == 1)
  #expect(progress.axes[1].status == .unavailable)
}
@MainActor
@Test func podStoreRejectsAStaleReviewSnapshot() throws {
  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data(reviewProgressJSON.utf8))
  let response = try #require(raw.progress)
  let fresh = try #require(PodMapper.mapReviewProgress(response))
  let stale = LiveReviewProgress(
    attempt: fresh.attempt,
    startedAt: fresh.startedAt,
    updatedAt: fresh.updatedAt.addingTimeInterval(-30),
    elapsedMs: 52_000,
    guardrailMs: fresh.guardrailMs,
    stage: .axes,
    axes: fresh.axes.map { LiveReviewAxis(axis: $0.axis, status: .queued, attempt: 0) }
  )
  let store = PodStore()
  store.upsertSession(Pod(
    id: "steady-lobster",
    status: .validating,
    branch: "main",
    profileName: "autopod",
    model: "reviewer",
    startedAt: fresh.startedAt
  ))

  store.applyReviewProgress("steady-lobster", progress: fresh)
  store.applyReviewProgress("steady-lobster", progress: stale)

  #expect(store.pods.first?.validationProgress?.reviewProgress == fresh)
  #expect(store.pods.first?.latestActivity?.contains("3/5 settled") == true)
}
