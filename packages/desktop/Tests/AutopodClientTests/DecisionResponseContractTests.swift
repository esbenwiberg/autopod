import AutopodClient
import Foundation
import Testing
@testable import AutopodDesktop

@Suite struct DecisionResponseContractTests {
  private func fixture() throws -> [String: Any] {
    let packages = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: packages.appendingPathComponent("shared/src/fixtures/pod-decision-responses.json"))
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test func preservesDaemonDecisionIdentityAndMappedQuestion() throws {
    let contract = try fixture()
    let detail = try JSONDecoder().decode(SessionResponse.self, from: JSONSerialization.data(withJSONObject: #require(contract["detail"])))
    let compact = try JSONDecoder().decode(CompactPodResponse.self, from: JSONSerialization.data(withJSONObject: #require(contract["compact"])))
    let pod = PodMapper.map(detail)
    let summary = PodMapper.map(compact)
    #expect(detail.pendingEscalation?.id == "decision-contract-question")
    #expect(detail.pendingEscalation?.podId == detail.id)
    #expect(detail.pendingEscalation?.response == nil)
    #expect(detail.finalization?.pendingDecisionId == "decision-contract-question")
    #expect(compact.finalization?.pendingDecisionId == detail.finalization?.pendingDecisionId)
    #expect(pod.escalationId == "decision-contract-question")
    #expect(summary.escalationId == nil)
    #expect(pod.status == .awaitingInput)
    #expect(summary.status == .awaitingInput)
    #expect(pod.escalationQuestion == "Which implementation should be preserved?")
    #expect(pod.escalationOptions == ["First", "Second"])
    #expect(pod.escalationType == "ask_human")
    #expect(summary.escalationQuestion == pod.escalationQuestion)
  }

  @Test(arguments: [false, true]) func acceptsMissingOrNullOptionalFieldsAndUnknownKeys(explicitNull: Bool) throws {
    let contract = try fixture()
    var detail = try #require(contract["detail"] as? [String: Any])
    var compact = try #require(contract["compact"] as? [String: Any])
    for key in ["finalization", "pendingEscalation", "options"] {
      if explicitNull { detail[key] = NSNull() } else { detail.removeValue(forKey: key) }
    }
    for key in ["finalization", "pendingEscalationSummary", "recordDiagnostics"] {
      if explicitNull { compact[key] = NSNull() } else { compact.removeValue(forKey: key) }
    }
    detail["futureResponseField"] = ["value": true]
    compact["futureResponseField"] = ["value": true]
    let response = try JSONDecoder().decode(SessionResponse.self, from: JSONSerialization.data(withJSONObject: detail))
    let summary = try JSONDecoder().decode(CompactPodResponse.self, from: JSONSerialization.data(withJSONObject: compact))
    #expect(response.finalization == nil)
    #expect(response.pendingEscalation == nil)
    #expect(response.pod == nil)
    #expect(summary.finalization == nil)
    #expect(summary.recordDiagnostics == nil)
    #expect(PodMapper.map(response).escalationId == nil)
    #expect(PodMapper.map(summary).escalationId == nil)
    #expect(PodMapper.map(response).escalationQuestion == nil)
    #expect(PodMapper.map(summary).escalationQuestion == nil)
  }
}
