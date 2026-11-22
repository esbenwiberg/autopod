import Foundation
import Testing
@testable import AutopodClient

@Test func fleetArchiveTransportRestoresVisibilityWithoutCallingExecutionControls() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FleetArchiveProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://fleet-archive.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  try await api.unarchivePod("retained")
}

private final class FleetArchiveProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fleet-archive.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.url?.path == "/pods/retained/archive")
    #expect(request.httpMethod == "DELETE")
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"fleetArchivedAt":null,"retainedResources":true}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
