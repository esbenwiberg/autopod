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
