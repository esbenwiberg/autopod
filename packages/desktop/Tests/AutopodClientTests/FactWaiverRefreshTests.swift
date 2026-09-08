import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor
@Test(arguments: ["running", "failed", "review_required"])
func factWaiverRefreshUsesServerStateWithoutWebSocket(status: String) async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FactWaiverFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://waiver-fixture.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let store = PodStore()
  let handler = ActionHandler(api: api, podStore: store, profileStore: ProfileStore())
  await handler.approveFactWaiver(status, factId: "fact", reason: "Inspected unavailable tool")
  #expect(handler.lastError == nil)
  let pod = try #require(store.pods.first)
  #expect(pod.id == status)
  #expect(pod.status.rawValue == status)
  #expect(pod.taskSummary?.factDeviations.first?.decision == "approved_waive")
  #expect(pod.taskSummary?.factDeviations.first?.reason == "Inspected unavailable tool")
  #expect(pod.errorSummary == (status == "running" ? nil : "Uncollected guidance retained"))
}

private final class FactWaiverFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "waiver-fixture.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let parts = request.url!.pathComponents
    let podId = parts[2]
    let body: String
    if request.url!.path.hasSuffix("/approve-waiver") {
      #expect(request.httpMethod == "POST")
      body = #"{"ok":true,"newCommits":false,"result":"fail"}"#
    } else {
      #expect(request.httpMethod == "GET")
      #expect(request.url!.path == "/pods/\(podId)")
      body = """
      {"id":"\(podId)","profileName":"test","task":"Keep saved guidance","status":"\(podId)",
      "model":"sonnet","runtime":"claude","executionTarget":"local","branch":"fixture",
      "containerId":"retained","worktreePath":null,"validationAttempts":1,"maxValidationAttempts":3,
      "lastValidationResult":null,"pendingEscalation":null,"escalationCount":0,"skipValidation":false,
      "createdAt":"2026-09-07T00:00:00Z","startedAt":null,"completedAt":null,
      "updatedAt":"2026-09-08T00:00:00Z","userId":"human","filesChanged":1,"linesAdded":2,"linesRemoved":0,
      "previewUrl":null,"prUrl":null,"plan":null,"progress":null,"claudeSessionId":null,"outputMode":"pr",
      "options":{"agentMode":"auto","output":"pr","validate":true,"promotable":false},
      "inputTokens":0,"outputTokens":0,"costUsd":0,"commitCount":1,"failureReason":"Uncollected guidance retained",
      "taskSummary":{"actualSummary":"Saved work","deviations":[],"factDeviations":[{"factId":"fact","action":"waive","decision":"approved_waive","reason":"Inspected unavailable tool","whyImpossible":"Tool unavailable in fixture"}]}}
      """
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
