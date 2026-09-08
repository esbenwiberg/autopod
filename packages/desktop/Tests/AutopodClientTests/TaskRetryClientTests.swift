import Foundation
import Testing

@testable import AutopodClient

@Test(arguments: ["validation", "sandbox_startup", "codex_interruption", "worker"])
func retryClientPreservesUnknownExecutionAndSeparateAuthorization(stage: String) async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [RetryFixtureProtocol.self]
  let api = DaemonAPI(
    baseURL: URL(string: "https://retry-fixture.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let state = try await api.getRetryState("pod", stage: stage)
  #expect(state.stage == stage)
  #expect(state.authorizationRequired == true)
  #expect(state.retryFailure == "unknown")
  #expect(state.executedCount == 3)
  #expect(state.admissionCount == 4)
  #expect(state.latest?.outcome == "unknown")
  #expect(state.latest?.providerRetryNotBefore == "2026-09-09T12:00:00.000Z")
  #expect(state.latest?.measuredDurationMs == nil)
  let input = TaskRetryAuthorizationRequest(
    requestKey: "stable-key", reason: "External condition checked", stage: stage)
  let encoded =
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: String]
  #expect(encoded["stage"] == stage)
  let first = try await api.authorizeRetry("pod", request: input)
  let duplicate = try await api.authorizeRetry("pod", request: input)
  #expect(first.id == duplicate.id)
  #expect(first.usedByAttemptId == nil)
  if stage == "worker" {
    try await api.triggerValidation("pod")
  } else {
    let resumed = try await api.resumePod("pod")
    #expect(resumed.action == "revalidate")
  }
}

private final class RetryFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "retry-fixture.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    let body: String
    if path.hasSuffix("retry-state") {
      #expect(request.httpMethod == "GET")
      body =
        #"{"taskId":"task","stage":"validation","backoffsMs":[1000,5000],"admissionCount":4,"executedCount":3,"transientRetryCount":2,"measuredDurationMs":15,"interruptedCount":1,"latest":{"id":"failed","outcome":"unknown","providerRetryNotBefore":"2026-09-09T12:00:00.000Z","startedAt":null,"endedAt":"2026-09-07T10:00:00Z","measuredDurationMs":null},"authorizations":[],"retryFailure":"unknown","authorizationRequired":true,"telemetry":"partial"}"#
        .replacingOccurrences(
          of: "\"stage\":\"validation\"",
          with:
            "\"stage\":\"\(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first(where: { $0.name == "stage" })!.value!)\""
        )
    } else if path.hasSuffix("retry-authorizations") {
      #expect(request.httpMethod == "POST")
      body =
        #"{"id":"grant","requestKey":"stable-key","failureId":"failed","reason":"External condition checked","createdAt":"2026-09-07T10:01:00Z","usedByAttemptId":null}"#
    } else if path.hasSuffix("/validate") {
      #expect(request.httpMethod == "POST")
      body = #"{"ok":true,"accepted":true}"#
    } else {
      #expect(path.hasSuffix("/resume"))
      #expect(request.httpMethod == "POST")
      body = #"{"ok":true,"action":"revalidate"}"#
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
