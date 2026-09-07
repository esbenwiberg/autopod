import Foundation
import Testing
@testable import AutopodClient

@Test func approvalClientSurfacesPreservationFailure() async throws {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [ApprovalPreservationProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://approval-preservation.invalid")!, token: "synthetic", session: URLSession(configuration: config))
  do {
    try await api.approvePod("failed")
    Issue.record("Failed preservation was accepted as an approval")
  } catch let error as DaemonError {
    if case .serverError(let status, let message) = error {
      #expect(status == 502)
      #expect(message.contains("Original resources retained"))
      #expect(message.contains("retry approval"))
    } else { Issue.record("Unexpected error: \(error)") }
  }
  try await api.approvePod("succeeded")
}

private final class ApprovalPreservationProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "approval-preservation.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path.hasSuffix("/approve") == true)
    let failed = request.url?.path == "/pods/failed/approve"
    let body = failed
      ? #"{"error":"BRANCH_PRESERVATION_FAILED","message":"Branch preservation failed. Original resources retained; repair remote access and retry approval."}"#
      : #"{"ok":true}"#
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: failed ? 502 : 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
