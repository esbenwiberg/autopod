import Foundation
import Testing
@testable import AutopodClient

@Test func rerunTemplateSurvivesDurableDraftWithoutApprovalOrLineage() throws {
  let data = Data(#"{"profileName":"profile","task":"Exact prior task","runtime":"codex","model":"gpt-5.6-sol","baseBranch":"main","options":{"agentMode":"auto","output":"pr","validate":true,"validationSuite":"full"},"specContextFiles":[{"path":"brief.md","content":"Preserve this context"}],"handoffInstructions":"Preserve the handoff","contract":{"contractVersion":1,"title":"Exact contract","dependsOn":[],"scenarios":[],"requiredFacts":[],"humanReview":[],"futurePolicy":{"required":true}}}"#.utf8)
  var request = try JSONDecoder().decode(IntentionalRerunDraft.self, from: data)
  request.intentionalRerun = IntentionalRerunRequest(ofPodId: "prior", reason: "Reviewed repeat", requestKey: "same-key")
  let saved = try JSONEncoder().encode(request)
  let restored = try JSONDecoder().decode(IntentionalRerunDraft.self, from: saved)
  #expect(restored.intentionalRerun?.requestKey == "same-key")
  let json = try JSONSerialization.jsonObject(with: saved) as! [String: Any]
  #expect((json["specContextFiles"] as? [[String: Any]])?.first?["content"] as? String == "Preserve this context")
  #expect(json["handoffInstructions"] as? String == "Preserve the handoff")
  #expect((json["contract"] as? [String: Any])?["futurePolicy"] != nil)
  #expect(json["skipValidation"] == nil); #expect(json["linkedSessionId"] == nil); #expect(json["branch"] == nil)
  #expect((json["options"] as? [String: Any])?["validate"] as? Bool == true)
}

@Test func dispatchReceiptKeepsReviewRequiredAndMissingEvidenceDistinct() throws {
  let empty = try JSONDecoder().decode(DispatchPreflightResponse.self, from: Data(#"{"latest":null}"#.utf8))
  #expect(empty.latest == nil)
  let receipt = try JSONDecoder().decode(DispatchPreflightResponse.self, from: Data(#"{"latest":{"id":"receipt","executionId":"execution","taskId":"task","repository":"host/repo","baseBranch":"main","baseCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"review_required","checkedAt":"2026-09-07","conflicts":[{"executionId":"prior-execution","podId":"prior","status":"deleted","evidence":"dispatch_receipt"}],"rerun":null}}"#.utf8))
  #expect(receipt.latest?.status == "review_required")
  #expect(receipt.latest?.conflicts.first?.status == "deleted")
  #expect(receipt.latest?.rerun == nil)
}

@Test func nativeContractPreservesDeclaredExecutionRequirements() throws {
  let raw = Data(#"{"contractVersion":1,"title":"Environment","dependsOn":[],"scenarios":[],"requiredFacts":[],"humanReview":[],"executionRequirements":{"version":1,"executables":["node"],"minimumMemoryBytes":2147483648,"minimumCpu":2}}"#.utf8)
  let contract = try JSONDecoder().decode(SpecContractResponse.self, from: raw)
  #expect(contract.executionRequirements?.minimumCpu == 2)
  let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(contract)) as! [String: Any]
  #expect((encoded["executionRequirements"] as? [String: Any])?["minimumMemoryBytes"] as? Int == 2147483648)
}

@Test func executionProvenanceKeepsValidationPurposeAndSupportsEarlierRecords() throws {
  var json: [String: Any] = [
    "executionId": "exec", "generation": 2, "checkedAt": "today", "status": "checked", "purpose": "validation", "runtime": "codex", "model": "worker",
    "contractHash": String(repeating: "a", count: 64),
    "release": ["source": "unavailable"],
    "capabilities": ["streamingExec": "unverified"],
    "commands": ["requirements": [], "unresolvedSources": [], "deferredArtifacts": [], "explicitDependencies": false],
    "diagnostics": [["code": "WORKER_CLI_NOT_REQUIRED", "detail": "No coding agent started"]]
  ]
  let current = try JSONDecoder().decode(ExecutionProvenance.self, from: JSONSerialization.data(withJSONObject: json))
  #expect(current.purpose == "validation"); #expect(current.cliVersion == nil)
  json.removeValue(forKey: "purpose")
  let legacy = try JSONDecoder().decode(ExecutionProvenance.self, from: JSONSerialization.data(withJSONObject: json))
  #expect(legacy.purpose == nil)
  #expect(legacy.subjectLabel == "Configured worker")
  json["purpose"] = "review"
  let historicalReview = try JSONDecoder().decode(ExecutionProvenance.self, from: JSONSerialization.data(withJSONObject: json))
  #expect(historicalReview.subjectLabel == "Configured worker")
  json["subject"] = "reviewer"
  json["runtime"] = "claude"
  json["model"] = "reviewer-model"
  json["providerId"] = "anthropic"
  json["providerAccountId"] = "review-account"
  let reviewer = try JSONDecoder().decode(ExecutionProvenance.self, from: JSONSerialization.data(withJSONObject: json))
  #expect(reviewer.subjectLabel == "Reviewer")
  #expect(reviewer.runtime == "claude"); #expect(reviewer.model == "reviewer-model")
  #expect(reviewer.providerId == "anthropic"); #expect(reviewer.providerAccountId == "review-account")
}

@Test func apiProvenanceDoesNotRequireOrDisplayCliIdentity() throws {
  let raw = Data(#"{"version":2,"surface":"provider-api","dispatchModel":"resolved","subject":"reviewer","purpose":"review","executionId":"exec","generation":1,"checkedAt":"today","status":"checked","runtime":null,"model":"alias","contractHash":"hash","release":{"source":"unavailable"},"capabilities":{"streamingExec":"unverified"},"commands":{"requirements":[],"unresolvedSources":[],"deferredArtifacts":[],"explicitDependencies":false},"diagnostics":[]}"#.utf8)
  let record = try JSONDecoder().decode(ExecutionProvenance.self, from: raw)
  #expect(record.runtime == nil)
  #expect(record.runtimeLabel == "Provider API · dispatch model resolved")
  #expect(record.imageLabel == "not applicable")
}
