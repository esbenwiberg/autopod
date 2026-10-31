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

@Test func reviewFailureLabelDistinguishesInfrastructureFromFindings() {
  let failedInfrastructure = reviewPhasePresentation(
    progress: nil,
    checks: ValidationChecks(smoke: true, review: nil, reviewSkipKind: "review-failed"),
    council: nil
  )
  let timedOutInfrastructure = reviewPhasePresentation(
    progress: nil,
    checks: ValidationChecks(smoke: true, review: nil, reviewSkipKind: "review-timeout"),
    council: nil
  )
  let findings = reviewPhasePresentation(
    progress: nil,
    checks: ValidationChecks(smoke: true, review: false),
    council: nil
  )

  #expect(failedInfrastructure.failureLabel == "Review infrastructure failed")
  #expect(timedOutInfrastructure.failureLabel == "Review timed out")
  #expect(findings.failureLabel == "Review flagged issues")

  let timeoutSummary = reviewInfrastructureSummaryCopy(for: "review-timeout")
  #expect(timeoutSummary?.title == "Review infrastructure needs attention")
  #expect(timeoutSummary?.subtitle == "The reviewer timed out before producing a verdict.")
  #expect(reviewInfrastructureSummaryCopy(for: nil) == nil)
}

@Test func reviewFailureRetainsActionableReasonAlongsideFindings() {
  let reason = "Foundry tool review unavailable on the selected provider binding; reconcile it before retry."
  let checks = ValidationChecks(
    smoke: true,
    review: false,
    reviewIssues: ["Retained finding from the completed review"],
    reviewReasoning: reason,
    reviewSkipReason: reason,
    reviewSkipKind: "review-failed"
  )
  let presentation = reviewPhasePresentation(progress: nil, checks: checks, council: nil)
  #expect(presentation.status == .failed)
  #expect(presentation.failureLabel.contains(reason))
  #expect(checks.reviewIssues == ["Retained finding from the completed review"])
}

@Test func unknownExecutionCopyPreservesRecoveryFencesWithoutClaimingExhaustedAttempts() {
  for code in ["EXEC_EXIT_UNVERIFIED", "CONTINUATION_OUTCOME_UNVERIFIED",
               "AZURE_SANDBOX_EXEC_INVALID_RESPONSE", "VALIDATION_ENGINE_TERMINATION_UNVERIFIED"] {
    let checks = ValidationChecks(smoke: false,
      infrastructureFailure: ValidationInfrastructureFailureResponse(
        phase: "setup", code: code, statusCode: 409,
        message: "Execution result not observed", retryable: false
      )
    )
    let description = reviewRequiredExplanation(for: checks, attempts: AttemptInfo(current: 3, max: 3))
    #expect(description.contains("outcome is unknown"))
    #expect(description.contains("inspect recovery evidence"))
    #expect(!description.contains("exhausted"))
  }
}

@Test func reviewRequiredCopyUsesRecordedFailureAndActualAttemptLimit() {
  let failure = ValidationChecks(smoke: false)
  #expect(!reviewRequiredExplanation(for: failure, attempts: AttemptInfo(current: 1, max: 3))
    .contains("exhausted"))
  #expect(reviewRequiredExplanation(for: failure, attempts: AttemptInfo(current: 3, max: 3))
    .contains("exhausted"))
  #expect(!reviewRequiredExplanation(for: nil, attempts: nil).contains("exhausted"))
  #expect(reviewRequiredExplanation(for: ValidationChecks(smoke: true, review: false), attempts: nil)
    .contains("Review findings"))
  #expect(reviewRequiredExplanation(
    for: ValidationChecks(smoke: true, reviewSkipKind: "review-timeout"),
    attempts: AttemptInfo(current: 3, max: 3)
  ).contains("Review infrastructure"))
}
