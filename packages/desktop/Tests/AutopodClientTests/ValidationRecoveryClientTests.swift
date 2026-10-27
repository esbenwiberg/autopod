import Foundation
import Testing
@testable import AutopodClient

@Test func validationRecoveryTransportPreservesIntentAndFailureIdentity() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ValidationRecoveryFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://validation-recovery.invalid")!, token: "synthetic",
                      session: URLSession(configuration: configuration))
  let state = try await api.getValidationRecovery("pod")
  #expect(state.generation == 3)
  #expect(state.fixValidation.allowed)
  for action in ["retry-checks", "fix-validation"] {
    let input = try ValidationRecoveryRequest(action: action, state: state)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
    #expect(json["action"] as? String == action)
    #expect(json["expectedGeneration"] as? Int == 3)
    #expect(json["expectedValidationTimestamp"] as? String == "2026-10-27T17:18:10Z")
    #expect(json["force"] == nil)
    #expect(json["authorized"] == nil)
    try await api.requestValidationRecovery("pod", input: input)
  }
  #expect(throws: (any Error).self) { try ValidationRecoveryRequest(action: "approve", state: state) }
}

private final class ValidationRecoveryFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "validation-recovery.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.url!.path == "/pods/pod/validation-recovery")
    let body: String
    let status: Int
    if request.httpMethod == "GET" {
      status = 200
      body = #"{"generation":3,"validationTimestamp":"2026-10-27T17:18:10Z","fixValidation":{"allowed":true},"retryChecks":{"allowed":true},"activeAction":null}"#
    } else {
      #expect(request.httpMethod == "POST")
      status = 202
      body = #"{"ok":true,"accepted":true}"#
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
