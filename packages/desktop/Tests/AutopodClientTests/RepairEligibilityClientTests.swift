import Foundation
import Testing
@testable import AutopodClient

@Test func repairEligibilityTransportKeepsCurrentLifecycleHold() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [RepairEligibilityFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://repair-eligibility.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let state = try await api.getReworkEligibility("synthetic")
  #expect(!state.eligible && state.code == "INFRASTRUCTURE_BLOCKED" && state.generation == 7)
  #expect(state.reason == "Current lifecycle held")
}

@Test func repairEligibilityDecodesStableHoldCodeAndLegacyAbsence() throws {
  let base = #"{"eligible":false,"status":"blocked","reason":"Current lifecycle held","generation":7,"failureId":null"#
  let held = try JSONDecoder().decode(ReworkEligibility.self,
    from: Data((base + #", "code":"INFRASTRUCTURE_BLOCKED"}"#).utf8))
  #expect(held.code == "INFRASTRUCTURE_BLOCKED" && held.generation == 7)
  let legacy = try JSONDecoder().decode(ReworkEligibility.self, from: Data((base + "}").utf8))
  #expect(legacy.code == nil && !legacy.eligible)
}

private final class RepairEligibilityFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "repair-eligibility.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.httpMethod == "GET" && request.url?.path == "/pods/synthetic/rework-v1/eligibility")
    let body = #"{"eligible":false,"status":"blocked","reason":"Current lifecycle held","generation":7,"failureId":null,"code":"INFRASTRUCTURE_BLOCKED"}"#
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
