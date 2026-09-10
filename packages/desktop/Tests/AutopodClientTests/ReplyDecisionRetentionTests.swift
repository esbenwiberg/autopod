import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor
@Test(arguments: ["failure", "unavailable", "awaiting_input", "validating", "running"])
func replyRetainsDecisionUntilServerStateIsObserved(outcome: String) async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ReplyDecisionProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://reply-fixture.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let store = PodStore()
  store.configure(api: api)
  var original = Pod(id: outcome, status: .awaitingInput, branch: "preserved", profileName: "test",
    model: "fixture", startedAt: Date(timeIntervalSince1970: 0), escalationQuestion: "Original decision",
    escalationOptions: ["Keep report only"])
  original.updatedAt = Date(timeIntervalSince1970: 0)
  store.upsertSession(original)
  let handler = ActionHandler(api: api, podStore: store, profileStore: ProfileStore())

  await handler.reply(outcome, message: "Keep report only")

  let pod = try #require(store.pods.first)
  let unavailable = outcome == "failure" || outcome == "unavailable"
  #expect(pod.status.rawValue == (unavailable ? "awaiting_input" : outcome))
  #expect(pod.escalationQuestion == (unavailable ? "Original decision" : outcome == "awaiting_input" ? "Follow-up decision" : nil))
  #expect(pod.escalationOptions == (unavailable ? ["Keep report only"] : outcome == "awaiting_input" ? ["Inspect first"] : nil))
  #expect(pod.branch == "preserved")
  #expect((handler.lastError != nil) == (outcome == "failure"))
  #expect(handler.pendingAction == nil)
}

private final class ReplyDecisionProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "reply-fixture.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let outcome = request.url!.pathComponents[2]
    let posting = request.httpMethod == "POST"
    #expect(request.url!.path == "/pods/\(outcome)" + (posting ? "/message" : ""))
    #expect(posting || request.httpMethod == "GET")
    let failing = posting ? outcome == "failure" : outcome == "unavailable"
    let body: String
    if failing {
      body = #"{"error":"Reply state unavailable"}"#
    } else if posting {
      body = #"{"ok":true}"#
    } else {
      let escalation = outcome == "awaiting_input"
        ? #"{"id":"next-decision","podId":"awaiting_input","type":"ask_human","timestamp":"2026-09-09T00:00:00Z","payload":{"question":"Follow-up decision","options":["Inspect first"]},"response":null}"#
        : "null"
      body = """
      {"id":"\(outcome)","profileName":"test","task":"Preserve human input","status":"\(outcome)",
      "model":"fixture","runtime":"codex","executionTarget":"sandbox","branch":"preserved",
      "validationAttempts":0,"maxValidationAttempts":3,"lastValidationResult":null,
      "pendingEscalation":\(escalation),"escalationCount":1,"skipValidation":false,
      "createdAt":"2026-09-09T00:00:00Z","updatedAt":"2026-09-09T00:01:00Z",
      "userId":"synthetic","filesChanged":0,"linesAdded":0,"linesRemoved":0,"outputMode":"pr",
      "options":{"agentMode":"auto","output":"pr","validate":true,"promotable":false},
      "inputTokens":0,"outputTokens":0,"costUsd":0,"commitCount":0}
      """
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: failing ? 500 : 200,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
