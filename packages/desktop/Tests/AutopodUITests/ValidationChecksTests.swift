import AutopodClient
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

@Test func validationInfrastructureFailureBlocksPassWithoutClaimingTestsFailed() {
  let checks = ValidationChecks(
    smoke: true,
    tests: nil,
    infrastructureFailure: ValidationInfrastructureFailureResponse(
      phase: "test",
      code: "AZURE_SANDBOX_HTTP_ERROR",
      statusCode: 403,
      message: "Azure Sandboxes returned an empty 403",
      retryable: true
    )
  )

  #expect(checks.tests == nil)
  #expect(checks.infrastructureFailure?.phase == "test")
  #expect(checks.allPassed == false)
}

@Test func infrastructureFailureUsesValidationOnlyResumeAction() {
  let infrastructure = ValidationChecks(
    smoke: true,
    infrastructureFailure: ValidationInfrastructureFailureResponse(
      phase: "lint",
      code: "AZURE_SANDBOX_HTTP_ERROR",
      statusCode: 403,
      message: "Azure Sandboxes returned an empty 403",
      retryable: true
    )
  )
  let failedReview = ValidationChecks(smoke: true, review: false)
  let exhausted = ValidationChecks(smoke: false)

  #expect(reviewRequiredPrimaryAction(for: infrastructure) == .resumeValidation)
  #expect(reviewRequiredPrimaryAction(for: failedReview) == .fixReview)
  #expect(reviewRequiredPrimaryAction(for: exhausted) == .extendAttempts)
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
