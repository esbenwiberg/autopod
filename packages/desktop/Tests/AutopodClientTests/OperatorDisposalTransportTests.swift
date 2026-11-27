import Foundation
import Testing
@testable import AutopodClient

@Test func operatorDisposalAcceptanceIsDistinctFromPhysicalCompletion() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [OperatorDisposalProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://operator-disposal.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let receipt = try await api.requestOperatorDisposal("exact-pod", generation: 1,
    intent: "delete", requestKey: "decision-1")
  #expect(receipt.state == "cleanup_pending")
  #expect(receipt.intent == "delete")
}

private final class OperatorDisposalProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "operator-disposal.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.url?.path == "/pods/exact-pod/operator-disposal")
    #expect(request.httpMethod == "POST")
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 202,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"contract":"operator-disposal-v1","podId":"exact-pod","generation":1,"requestKey":"decision-1","intent":"delete","acceptedAt":"2026-11-27","state":"cleanup_pending","diagnostics":[]}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
