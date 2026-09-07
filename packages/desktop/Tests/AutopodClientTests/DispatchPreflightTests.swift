import Foundation
import Testing
@testable import AutopodClient

@Test func rerunTemplateSurvivesDurableDraftWithoutApprovalOrLineage() throws {
  let data = Data(#"{"profileName":"profile","task":"Exact prior task","runtime":"codex","model":"gpt-5.6-sol","baseBranch":"main","options":{"agentMode":"auto","output":"pr","validate":true,"validationSuite":"full"},"specContextFiles":[{"path":"brief.md","content":"Preserve this context"}],"handoffInstructions":"Preserve the handoff"}"#.utf8)
  var request = try JSONDecoder().decode(CreateSessionRequest.self, from: data)
  request.intentionalRerun = IntentionalRerunRequest(ofPodId: "prior", reason: "Reviewed repeat", requestKey: "same-key")
  let saved = try JSONEncoder().encode(request)
  let restored = try JSONDecoder().decode(CreateSessionRequest.self, from: saved)
  #expect(restored.intentionalRerun?.requestKey == "same-key")
  #expect(restored.specContextFiles?.first?.content == "Preserve this context")
  #expect(restored.handoffInstructions == "Preserve the handoff")
  let json = try JSONSerialization.jsonObject(with: saved) as! [String: Any]
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
