import Testing
@testable import AutopodUI

@Test func reviewInfrastructureFailuresFailValidationChecks() {
  let failed = ValidationChecks(
    smoke: true,
    review: nil,
    reviewSkipKind: "review-failed"
  )
  let timedOut = ValidationChecks(
    smoke: true,
    review: nil,
    reviewSkipKind: "review-timeout"
  )

  #expect(failed.review == false)
  #expect(failed.allPassed == false)
  #expect(timedOut.review == false)
  #expect(timedOut.allPassed == false)
}

@Test func intentionalReviewSkipsRemainNeutral() {
  let disabled = ValidationChecks(
    smoke: true,
    review: nil,
    reviewSkipKind: "profile-skip"
  )

  #expect(disabled.review == nil)
  #expect(disabled.allPassed == true)
}
