import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func reviewCouncilDecodesAndPresentsLedgerLifecycle() throws {
  let data = """
  {"status":"fail","reasoning":"broad","issues":["legacy"],"model":"m","screenshots":[],"diff":"","tokenUsage":{"inputTokens":12,"outputTokens":4,"costUsd":0.03},"firstGateOverflow":{"reportedCount":9,"retainedFindingCount":2},"reviewBatch":{"id":"packet","diffHash":"abcdef123456","reviewedHead":"head","promptVersion":"p2","schemaVersion":"s2","model":"m","axes":[{"axis":"security_authority","status":"unavailable","attempts":2,"error":"Network unavailable"},{"axis":"contract_completeness","status":"completed","attempts":1}],"candidates":[{"id":"initial-1","source":"initial-review","issue":"raw"},{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","line":4,"symbol":"run","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9}],"initialFindings":[{"id":"initial-1","source":"initial-review","issue":"raw"}],"accepted":[{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9}],"rejected":[{"sourceIds":["x"],"reason":"duplicate"}],"merged":[{"finding":{"id":"s2","axis":"tests_integration","severity":"MEDIUM","path":"b.swift","claim":"merged","evidence":"e","remediation":"r","confidence":0.5},"sourceIds":["a","b"]}],"synthesis":"model","durationMs":1200,"ledger":[{"semanticId":"review:one","finding":{"id":"s1","axis":"security_authority","severity":"HIGH","path":"a.swift","claim":"same text","evidence":"proof","remediation":"fix","confidence":0.9},"state":"new","priorSourceIds":[],"currentSourceIds":["s1"]},{"semanticId":"review:two","finding":{"id":"initial-1","source":"initial-review","issue":"raw"},"state":"fixed","priorSourceIds":["initial-1"],"currentSourceIds":[],"closureEvidence":"verified"}],"repairDelta":{"status":"available","fromHead":"a","toHead":"b","diffHash":"d"},"closureVerification":{"status":"completed","decisions":[{"semanticId":"review:two","fixed":true,"evidence":"verified"}]}}}
  """.data(using: .utf8)!
  let review = try JSONDecoder().decode(TaskReviewResponse.self, from: data)
  let council = try #require(review.reviewBatch.map(ReviewCouncil.init))
  #expect(council.activeCount == 1)
  #expect(council.findings(filter: "open").map(\.id) == ["review:one"])
  #expect(council.findings(filter: "fixed").first?.closureEvidence == "verified")
  #expect(council.overflow?.reportedCount == 9)
}

@Test func reviewCouncilFallsBackToAcceptedFindingsWithoutLedger() throws {
  let finding = StructuredReviewFindingResponse(id: "semantic", axis: "tests_integration", severity: "MEDIUM", path: "x", line: nil, symbol: nil, claim: "claim", evidence: "e", remediation: "r", confidence: 1, state: nil)
  let batch = ReviewBatchResponse(id: "p", diffHash: "d", reviewedHead: "h", promptVersion: "p", schemaVersion: "s", model: "m", axes: [], candidates: [.structured(finding)], initialFindings: [], accepted: [.structured(finding)], rejected: [], merged: [], synthesis: "deterministic-fallback", durationMs: 1, infrastructureUnavailable: true, tokenUsage: nil, ledger: nil, repairDelta: nil, closureVerification: nil, firstGateOverflow: nil)
  let council = ReviewCouncil(batch)
  #expect(council.findings(filter: "open").map(\.id) == ["semantic"])
  #expect(council.infrastructureUnavailable)
}

@Test func legacyReviewDecodesWithoutCouncil() throws {
  let data = """{"status":"pass","reasoning":"ok","issues":[],"model":"m","screenshots":[],"diff":""}""".data(using: .utf8)!
  #expect(try JSONDecoder().decode(TaskReviewResponse.self, from: data).reviewBatch == nil)
}
