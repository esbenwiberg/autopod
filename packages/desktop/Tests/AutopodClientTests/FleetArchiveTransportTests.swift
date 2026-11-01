import Foundation
import Testing
@testable import AutopodClient

@Test func fleetArchiveTransportAcknowledgesRetentionWithoutCallingExecutionControls() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FleetArchiveProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://fleet-archive.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  try await api.archivePod("retained", reason: "Retain source and reports while hiding card")
  try await api.unarchivePod("retained")
}

private final class FleetArchiveProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fleet-archive.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.url?.path == "/pods/retained/archive")
    #expect(["POST", "DELETE"].contains(request.httpMethod ?? ""))
    if request.httpMethod == "POST" {
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          data.append(buffer, count: count)
        }
      }
      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      #expect(body?["retainResources"] as? Bool == true)
      #expect(body?["reason"] as? String == "Retain source and reports while hiding card")
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"fleetArchivedAt":null,"retainedResources":true}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
