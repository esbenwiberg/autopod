import Testing
@testable import AutopodUI

@Suite("FactRequestPresentationTests")
struct FactRequestPresentationTests {
  private func evidence(_ status: String, exitCode: Int? = nil) -> FactCheckDetail {
    FactCheckDetail(factId: "fact", proves: [], artifactPath: "proof.swift", command: "check",
      passed: false, status: status, exitCode: exitCode, reasoning: "Validator explanation")
  }

  private func request(_ action: String = "waive", decision: String? = nil) -> FactDeviationItem {
    FactDeviationItem(factId: "fact", action: action, reason: "Request reason",
      whyImpossible: "Requires Mac", decision: decision)
  }

  @Test func currentPendingRequestsIncludeValidatorGeneratedStates() {
    let fact = evidence("pending_human")
    let rows = currentFactRequests(deviations: [], evidence: [fact])
    #expect(rows.count == 1)
    #expect(rows.first?.factId == "fact")
    #expect(factWaiverAvailable(evidence: fact, request: nil, isCurrent: true, podStatus: .failed))
    #expect(factWaiverAvailable(evidence: fact, request: request(), isCurrent: true, podStatus: .reviewRequired))
    #expect(currentFactRequests(deviations: [request()], evidence: [fact]).count == 1)
  }

  @Test func requestWithoutEvidenceIsVisibleButNotActionable() {
    let rows = currentFactRequests(deviations: [request()], evidence: [])
    #expect(rows.count == 1)
    #expect(rows.first?.request?.reason == "Request reason")
    #expect(rows.first?.request?.whyImpossible == "Requires Mac")
    #expect(!factWaiverAvailable(evidence: nil, request: request(), isCurrent: true, podStatus: .failed))
    #expect(factWaiverUnavailableReason(evidence: nil, isCurrent: true)?.contains("Awaiting") == true)
  }

  @Test func ordinaryFailureDirectsToCommandOutput() {
    let fact = evidence("fail", exitCode: 1)
    #expect(!factWaiverAvailable(evidence: fact, request: request(), isCurrent: true, podStatus: .failed))
    #expect(factWaiverUnavailableReason(evidence: fact, isCurrent: true)?.contains("Fact Command Output") == true)
    #expect(currentFactRequests(deviations: [], evidence: [fact]).isEmpty)
  }

  @Test func historicalPendingIsReadOnlyAndTerminalPodsCannotApprove() {
    let fact = evidence("pending_human")
    #expect(!factWaiverAvailable(evidence: fact, request: nil, isCurrent: false, podStatus: .failed))
    #expect(factWaiverUnavailableReason(evidence: fact, isCurrent: false)?.contains("Current") == true)
    #expect(!factWaiverAvailable(evidence: fact, request: nil, isCurrent: true, podStatus: .complete))
  }

  @Test func replacementRemainsDistinctFromWaiver() {
    let fact = evidence("pending_human")
    let replacement = request("replace")
    let rows = currentFactRequests(deviations: [replacement], evidence: [fact])
    #expect(rows.count == 1)
    #expect(rows.first?.request?.action == "replace")
    #expect(!factWaiverAvailable(evidence: fact, request: replacement, isCurrent: true, podStatus: .failed))
    #expect(!factWaiverAvailable(evidence: fact, request: request(decision: "rejected"), isCurrent: true, podStatus: .failed))
    #expect(currentFactRequests(deviations: [request(decision: "approved_waive")], evidence: [fact]).isEmpty)
  }
}
