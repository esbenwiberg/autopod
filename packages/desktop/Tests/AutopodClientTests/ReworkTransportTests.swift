import Foundation
import Testing
@testable import AutopodClient

@Test func versionedReworkPreservesGuidanceAndNeverFallsBackToValidate() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ReworkFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://rework-fixture.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let eligibility = try await api.getReworkEligibility("fixture")
  #expect(eligibility.status == "grant_recorded" && eligibility.eligible)
  let input = ReworkRequest(requestKey: "stable-key", generation: eligibility.generation, guidance: "Retain edits")
  let first = try await api.requestRework("fixture", input: input)
  let observed = try await api.getReworkRequest("fixture", requestKey: input.requestKey)
  #expect(first.requestKey == observed.requestKey && observed.guidance == input.guidance)
  do {
    _ = try await api.getReworkEligibility("older")
    Issue.record("Older daemon must fail closed")
  } catch DaemonError.notFound(_) { }
  let decision = TaskRetryAuthorizationRequest(requestKey: "grant-key", reason: "Inspected failure", stage: "worker", expectedFailureId: "displayed-failure")
  let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decision)) as! [String: String]
  #expect(body["expectedFailureId"] == "displayed-failure")
}
private final class ReworkFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "rework-fixture.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    #expect(!path.hasSuffix("/validate"))
    let body: String
    let status: Int
    if path.contains("/older/") { status = 404; body = #"{"error":"unsupported"}"# }
    else if path.hasSuffix("/eligibility") {
      status = 200
      #expect(request.httpMethod == "GET")
      body = #"{"eligible":true,"status":"grant_recorded","reason":"Usable grant recorded","generation":3,"failureId":"failure"}"#
    } else {
      status = 200
      if request.httpMethod == "POST" {
        #expect(path.hasSuffix("/rework-v1"))
      } else { #expect(path.hasSuffix("/requests/stable-key")) }
      body = #"{"requestKey":"stable-key","generation":3,"guidance":"Retain edits","settledAt":null,"error":null}"#
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
      httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
