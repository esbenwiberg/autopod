import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func reviewCouncilDecodesAndPresentsLedgerLifecycle() throws {
  let data = """
  {"status":"fail","reasoning":"broad","issues":["legacy"],"model":"m","screenshots":[],"diff":"","tokenUsage":{"inputTokens":12,"outputTokens":4,"costUsd":0.03},"firstGateOverflow":{"reportedCount":9,"retainedFindingCount":2},"reviewBatch":{"id":"packet","diffHash":"abcdef123456","reviewedHead":"head","promptVersion":"p2","schemaVersion":"s2","model":"m","axes":[{"axis":"security_authority","status":"unavailable","attempts":2,"durationMs":400,"error":"Network unavailable"},{"axis":"contract_completeness","status":"completed","attempts":1,"durationMs":200}],"candidates":[{"id":"initial-1","source":"initial-review","issue":"raw"},{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","line":4,"symbol":"run","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9}],"initialFindings":[{"id":"initial-1","source":"initial-review","issue":"raw"}],"accepted":[{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9}],"rejected":[{"sourceIds":["x"],"reason":"duplicate"}],"merged":[{"finding":{"id":"s2","axis":"tests_integration","severity":"MEDIUM","path":"b.swift","claim":"merged","evidence":"e","remediation":"r","confidence":0.5},"sourceIds":["a","b"]}],"synthesis":"model","durationMs":1200,"tokenUsage":{"inputTokens":10,"outputTokens":5,"cachedInputTokens":2,"cacheCreationInputTokens":1,"costUsd":0.02},"ledger":[{"semanticId":"review:one","finding":{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9},"state":"new","priorSourceIds":[],"currentSourceIds":["s1"]},{"semanticId":"review:two","finding":{"id":"initial-1","source":"initial-review","issue":"raw"},"state":"fixed","priorSourceIds":["initial-1"],"currentSourceIds":[],"closureEvidence":"verified"}],"repairDelta":{"status":"available","fromHead":"a","toHead":"b","diffHash":"d"},"closureVerification":{"status":"completed","decisions":[{"semanticId":"review:two","fixed":true,"evidence":"verified"}]}}}
  """.data(using: .utf8)!
  let review = try JSONDecoder().decode(TaskReviewResponse.self, from: data)
  let council = try #require(reviewCouncil(from: review))
  #expect(council.activeCount == 1)
  #expect(council.findings(filter: "open").map(\.id) == ["review:one"])
  #expect(council.findings(filter: "fixed").first?.closureEvidence == "verified")
  #expect(council.overflow?.reportedCount == 9)
  #expect(review.reviewBatch?.candidates.count == 2)
  #expect(review.reviewBatch?.axes.first?.durationMs == 400)
  #expect(council.rejected.first?.sourceIds == ["x"])
  #expect(council.merged.first?.sourceIds == ["a", "b"])
  #expect(council.repairDelta?.diffHash == "d")
  #expect(council.closureVerification?.decisions.first?.fixed == true)
  #expect(council.tokenUsage?.inputTokens == 12)
  #expect(council.tokenUsage?.outputTokens == 4)
  #expect(council.tokenUsage?.costUsd == 0.03)
}

@Test func reviewCouncilFallsBackToAcceptedFindingsWithoutLedger() throws {
  let finding = StructuredReviewFindingResponse(id: "semantic", axis: "tests_integration", severity: "MEDIUM", path: "x", line: nil, symbol: nil, claim: "claim", evidence: "e", remediation: "r", confidence: 1, state: nil)
  let batch = ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [.structured(finding)], initialFindings: [], accepted: [.structured(finding)], rejected: [], merged: [], synthesis: "deterministic-fallback", durationMs: 1, infrastructureUnavailable: true, tokenUsage: nil, ledger: nil, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)
  let council = ReviewCouncil(batch)
  #expect(council.findings(filter: "open").map(\.id) == ["semantic"])
  #expect(council.infrastructureUnavailable)
  let legacy = ValidationFindingResponse(id: "review:fingerprint", source: "task_review", description: "[MEDIUM] x — claim", reasoning: nil)
  let displayed = try #require(council.findings.first)
  #expect(council.canonicalDismissFinding(for: displayed, in: [legacy])?.id == "review:fingerprint")
  let ambiguous = ValidationFindingResponse(id: "review:other", source: "task_review", description: legacy.description, reasoning: nil)
  #expect(council.canonicalDismissFinding(for: displayed, in: [legacy, ambiguous]) == nil)
}

@Test func reviewPresentationPreservesFailedHistoryVerdictWhenCouncilIsUnavailable() throws {
  let data = """
  {"status":"fail","reasoning":"blocked","issues":[],"model":"m","screenshots":[],"diff":"","reviewBatch":{"id":"history-packet","diffHash":"d","reviewedHead":"h","promptVersion":"p","schemaVersion":"s","model":"m","axes":[{"axis":"security_authority","status":"unavailable","attempts":2,"error":"Network unavailable"}],"candidates":[],"initialFindings":[],"accepted":[],"rejected":[],"merged":[],"synthesis":"model","durationMs":1,"infrastructureUnavailable":true,"ledger":[{"semanticId":"review:active","finding":{"id":"active","axis":"contract_completeness","severity":"MEDIUM","path":"a.swift","claim":"still blocked","evidence":"e","remediation":"r","confidence":1},"state":"new","priorSourceIds":[],"currentSourceIds":["active"]}]}}
  """.data(using: .utf8)!
  let review = try JSONDecoder().decode(TaskReviewResponse.self, from: data)
  let council = try #require(reviewCouncil(from: review))

  let checks = ValidationChecks(smoke: true, review: false, reviewCouncil: council)
  let presentation = reviewPhasePresentation(progress: nil, checks: checks, council: council)
  #expect(presentation.status == .failed)
  #expect(presentation.councilUnavailableReason == "infrastructure unavailable")
  #expect(council.findings(filter: .open).map(\.id) == ["review:active"])
}

@Test func reviewPresentationPreservesSkippedAndPassedVerdicts() {
  let skipped = reviewPhasePresentation(
    progress: nil,
    checks: ValidationChecks(smoke: true, review: nil),
    council: nil
  )
  #expect(skipped.status == .skipped)

  let batch = ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [], initialFindings: [], accepted: [], rejected: [], merged: [], synthesis: "model", durationMs: 1, infrastructureUnavailable: true, tokenUsage: nil, ledger: nil, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)
  let council = ReviewCouncil(batch)
  let presentation = reviewPhasePresentation(
    progress: nil,
    checks: ValidationChecks(smoke: true, review: true, reviewCouncil: council),
    council: council
  )
  #expect(presentation.status == .passed)
  #expect(presentation.councilUnavailableReason == "infrastructure unavailable")
}

@Test func reviewCouncilFallsBackToBatchTokenUsage() throws {
  let usage = ReviewTokenUsageResponse(inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, cacheCreationInputTokens: nil, costUsd: 0.01)
  let batch = ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [], initialFindings: [], accepted: [], rejected: [], merged: [], synthesis: "model", durationMs: 1, infrastructureUnavailable: nil, tokenUsage: usage, ledger: nil, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)
  let council = ReviewCouncil(batch)
  #expect(council.tokenUsage?.inputTokens == 7)
  #expect(council.tokenUsage?.cachedInputTokens == 2)
}

@Test func legacyReviewDecodesWithoutCouncil() throws {
  let data = """{"status":"pass","reasoning":"ok","issues":[],"model":"m","screenshots":[],"diff":""}""".data(using: .utf8)!
  #expect(try JSONDecoder().decode(TaskReviewResponse.self, from: data).reviewBatch == nil)
  #expect(reviewCouncil(from: try JSONDecoder().decode(TaskReviewResponse.self, from: data)) == nil)
  #expect(reviewPresentationMode(council: nil) == .legacy)
}

@Test func legacyReviewPresentationKeepsExistingReasoningAndFindings() {
  let fallback = [ValidationFindingResponse(id: "review:one", source: "task_review", description: "[HIGH] a.swift:4 — legacy finding", reasoning: nil)]
  let fallbackPresentation = legacyReviewPresentation(council: nil, issues: [], fallbackFindings: fallback, reasoning: "legacy reasoning")
  #expect(fallbackPresentation?.issues == ["[HIGH] a.swift:4 — legacy finding"])
  #expect(fallbackPresentation?.showsFindings == true)
  #expect(fallbackPresentation?.showsReasoning == false)

  let reasoningPresentation = legacyReviewPresentation(council: nil, issues: [], fallbackFindings: [], reasoning: "legacy reasoning")
  #expect(reasoningPresentation?.showsReasoning == true)
  #expect(reasoningPresentation?.reasoning == "legacy reasoning")

  let explicitPresentation = legacyReviewPresentation(council: nil, issues: ["saved legacy issue"], fallbackFindings: fallback, reasoning: nil)
  #expect(explicitPresentation?.issues == ["saved legacy issue"])
  #expect(legacyReviewPresentation(council: ReviewCouncil(ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [], initialFindings: [], accepted: [], rejected: [], merged: [], synthesis: "model", durationMs: 1, infrastructureUnavailable: nil, tokenUsage: nil, ledger: nil, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)), issues: [], fallbackFindings: fallback, reasoning: "legacy") == nil)
}

@Test func deterministicUnavailableBatchDecodesSafely() throws {
  let data = """
  {"status":"uncertain","reasoning":"infra","issues":[],"model":"m","screenshots":[],"diff":"","reviewBatch":{"id":"p","diffHash":"d","reviewedHead":"h","promptVersion":"p","schemaVersion":"s","model":"m","axes":[{"axis":"contract_completeness","status":"unavailable","attempts":3,"error":"Council runner unavailable"}],"candidates":[],"initialFindings":[],"accepted":[],"rejected":[],"merged":[],"synthesis":"deterministic-fallback","durationMs":42,"infrastructureUnavailable":true}}
  """.data(using: .utf8)!
  let review = try JSONDecoder().decode(TaskReviewResponse.self, from: data)
  let council = try #require(reviewCouncil(from: review))
  #expect(council.synthesis == "deterministic-fallback")
  #expect(council.infrastructureUnavailable)
  #expect(council.axes.first?.error == "Council runner unavailable")
}

@Test func lifecycleCountsGroupingSortingAndCanonicalDismissal() throws {
  func structured(_ id: String, _ axis: String, _ severity: String, claim: String = "duplicate") -> ReviewFindingCandidateResponse {
    .structured(StructuredReviewFindingResponse(id: id, axis: axis, severity: severity, path: "x.swift", line: 3, symbol: "run", claim: claim, evidence: "e", remediation: "r", confidence: 1, state: nil))
  }
  let entries = [
    ReviewFindingLedgerEntryResponse(semanticId: "review:z", finding: structured("z", "security_authority", "MEDIUM"), state: "open", priorSourceIds: [], currentSourceIds: ["z"], closureEvidence: nil),
    ReviewFindingLedgerEntryResponse(semanticId: "review:a", finding: structured("a", "contract_completeness", "CRITICAL"), state: "new", priorSourceIds: [], currentSourceIds: ["a"], closureEvidence: nil),
    ReviewFindingLedgerEntryResponse(semanticId: "review:b", finding: structured("b", "contract_completeness", "HIGH"), state: "regressed", priorSourceIds: ["old"], currentSourceIds: ["b"], closureEvidence: nil),
    ReviewFindingLedgerEntryResponse(semanticId: "review:c", finding: .initial(InitialReviewFindingResponse(id: "i", source: "initial-review", issue: "raw")), state: "fixed", priorSourceIds: ["i"], currentSourceIds: [], closureEvidence: "bounded"),
  ]
  let batch = ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [], initialFindings: [], accepted: [], rejected: [.init(sourceIds: ["r"], reason: "noise")], merged: [], synthesis: "model", durationMs: 1, infrastructureUnavailable: nil, tokenUsage: nil, ledger: entries, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)
  let council = ReviewCouncil(batch)
  #expect(council.lifecycleCounts[.open] == 2)
  #expect(council.lifecycleCounts[.fixed] == 1)
  #expect(council.lifecycleCounts[.regressed] == 1)
  #expect(council.lifecycleCounts[.rejected] == 1)
  #expect(council.lifecycleCounts[.all] == 5)
  #expect(council.findings(filter: .all).map(\.id) == ["review:a", "review:b", "review:z", "review:c"])
  #expect(council.groups(filter: .all).map(\.axis) == ["contract_completeness", "security_authority", nil])
  let available = [
    ValidationFindingResponse(id: "review:a", source: "task_review", description: "duplicate", reasoning: nil),
    ValidationFindingResponse(id: "review:z", source: "task_review", description: "duplicate", reasoning: nil),
  ]
  #expect(council.canonicalDismissFinding(for: "review:z", in: available)?.id == "review:z")
  let duplicateTextFinding = try #require(council.findings.first { $0.id == "review:z" })
  #expect(council.canonicalDismissFinding(for: duplicateTextFinding, in: available)?.id == "review:z")
  #expect(reviewPresentationMode(council: council) == .council)
  #expect(distinctBroadReviewIssues(["duplicate", "[MEDIUM] x.swift:3 — duplicate", "broad context"], council: council) == ["broad context"])
  #expect(distinctBroadReviewIssues(["duplicate"], council: nil) == ["duplicate"])
}

@Test func overflowKeepsRetainedFindingDismissalAndTopLevelWins() throws {
  let data = """
  {"status":"fail","reasoning":"x","issues":[],"model":"m","screenshots":[],"diff":"","firstGateOverflow":{"reportedCount":8,"retainedFindingCount":3},"reviewBatch":{"id":"p","diffHash":"d","reviewedHead":"h","promptVersion":"p","schemaVersion":"s","model":"m","axes":[],"candidates":[],"initialFindings":[],"accepted":[],"rejected":[],"merged":[],"synthesis":"model","durationMs":1}}
  """.data(using: .utf8)!
  let council = try #require(reviewCouncil(from: JSONDecoder().decode(TaskReviewResponse.self, from: data)))
  let finding = ValidationFindingResponse(id: "review:a", source: "task_review", description: "x", reasoning: nil)
  #expect(council.overflow?.reportedCount == 8)
  #expect(council.canonicalDismissFinding(for: "review:a", in: [finding])?.id == "review:a")
}

@Test func historicalAttemptUsesItsOwnFrozenCouncilSnapshot() throws {
  let data = """
  {"podId":"lonely-panther","attempt":1,"timestamp":"2026-08-04T00:00:00Z","smoke":{"status":"pass","build":{"status":"pass","output":"","duration":1},"health":{"status":"pass","url":"http://x","responseCode":200,"duration":1},"pages":[]},"taskReview":{"status":"pass","reasoning":"x","issues":[],"model":"m","screenshots":[],"diff":"","reviewBatch":{"id":"attempt-one","diffHash":"d","reviewedHead":"h","promptVersion":"p","schemaVersion":"s","model":"m","axes":[],"candidates":[],"initialFindings":[],"accepted":[],"rejected":[],"merged":[],"synthesis":"model","durationMs":1}},"overall":"pass","duration":2}
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(ValidationResponse.self, from: data)
  #expect(validationHistoryReviewCouncil(response)?.id == "attempt-one")
}
