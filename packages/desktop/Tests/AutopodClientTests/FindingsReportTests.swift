import Foundation
import Testing
@testable import AutopodClient

@Test func findingsReportUsesExactArchivedIdentityAndDecodesText() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FindingsReportProtocol.self]
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let api = DaemonAPI(baseURL: URL(string: "https://findings.example.com")!,
    token: "synthetic", session: session)
  let receipt = try JSONDecoder().decode(ResearchFindingsResponse.self, from: Data("""
    {"generation":2,"cycle":3,"configDigest":"frozen","evidenceHash":"reviewed",
     "summary":{"actualSummary":"Unresolved investigation","deviations":[]},
     "readyAt":"2026-11-01T00:00:00Z","acceptance":null}
    """.utf8))
  let report = try await api.getFindingsFileContent("research-pod", findings: receipt, path: "report.md")
  #expect(report.content == "Unresolved investigation")
  #expect(report.encoding == nil)
  do {
    _ = try await api.getFindingsFileContent("research-pod", findings: receipt, path: "forged.md")
    Issue.record("A mismatched report receipt must be rejected")
  } catch {
    #expect(String(describing: error).contains("displayed findings receipt"))
  }
}

private final class FindingsReportProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url else { return }
    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let path = query.first { $0.name == "path" }?.value ?? ""
    guard url.path == "/pods/research-pod/findings-receipts/2/3/content",
          query.first(where: { $0.name == "evidenceHash" })?.value == "reviewed" else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let content = Data("Unresolved investigation".utf8)
    let body: [String: Any] = ["path": path, "content": content.base64EncodedString(),
      "size": content.count, "encoding": "base64", "evidenceHash": path == "forged.md" ? "changed" : "reviewed"]
    do {
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
