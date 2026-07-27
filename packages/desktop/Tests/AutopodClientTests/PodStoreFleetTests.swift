import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop

@MainActor
@Test func podStoreLoadsEveryCompactPageWithoutDetailRequests() async throws {
  let recorder = FleetRequestRecorder()
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FleetURLProtocol.self]
  FleetURLProtocol.handler = { request in
    await recorder.record(request.url!)
    if request.url?.path == "/pods/scores" {
      return SelfResponse.json("[]", for: request)
    }
    let hasCursor = request.url?.query?.contains("cursor=") == true
    return SelfResponse.json(
      compactPage(id: hasCursor ? "older-pod" : "newer-pod", hasNext: !hasCursor),
      for: request
    )
  }
  defer { FleetURLProtocol.handler = nil }

  let api = DaemonAPI(
    baseURL: URL(string: "https://daemon.example.com")!,
    token: "token",
    session: URLSession(configuration: configuration)
  )
  let store = PodStore()
  store.configure(api: api)
  await store.loadSessions()

  #expect(store.pods.map(\.id) == ["newer-pod", "older-pod"])
  #expect(await recorder.podPaths == ["/pods", "/pods"])
}

@MainActor
@Test func podStoreKeepsVisibleFleetWhenCompactRefreshFails() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [FleetURLProtocol.self]
  FleetURLProtocol.handler = { request in
    if request.url?.path == "/pods/scores" {
      return SelfResponse.json("[]", for: request)
    }
    return SelfResponse.json(compactPage(id: "visible-pod", hasNext: false), for: request)
  }
  defer { FleetURLProtocol.handler = nil }

  let api = DaemonAPI(
    baseURL: URL(string: "https://daemon.example.com")!,
    token: "token",
    session: URLSession(configuration: configuration)
  )
  let store = PodStore()
  store.configure(api: api)
  await store.loadSessions()
  FleetURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
  await store.loadSessions()

  #expect(store.pods.map(\.id) == ["visible-pod"])
}

private func compactPage(id: String, hasNext: Bool) -> String {
  let nextCursor = hasNext ? #""next-page""# : "null"
  return """
  {"pods":[{
    "id":"\(id)","title":"\(id) title","taskSummary":"Browse summary","profileName":"test",
    "status":"complete","model":"sonnet","runtime":"claude","executionTarget":"local",
    "branch":"autopod/\(id)","baseBranch":"main","seriesId":null,"seriesName":null,
    "options":{"agentMode":"auto","output":"pr","validationSuite":"full"},
    "hasWebUi":false,"previewUrl":null,"containerId":null,"worktreePath":null,
    "createdAt":"2026-07-01T00:00:00Z","startedAt":null,"runningAt":null,
    "updatedAt":"2026-07-01T00:00:00Z","completedAt":null,"lastHeartbeatAt":null,
    "failureReason":null,"mergeBlockReason":null,"lastCorrectionMessage":null,
    "pendingEscalationSummary":null,"progressSummary":null
  }],"nextCursor":\(nextCursor)}
  """
}

private enum SelfResponse {
  static func json(_ body: String, for request: URLRequest) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    return (response, Data(body.utf8))
  }
}

private actor FleetRequestRecorder {
  private(set) var podPaths: [String] = []

  func record(_ url: URL) {
    if url.path == "/pods" { podPaths.append(url.path) }
  }
}

private final class FleetURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) async throws -> (HTTPURLResponse, Data)
  nonisolated(unsafe) static var handler: Handler?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    Task {
      do {
        let (response, data) = try await handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }
  }

  override func stopLoading() {}
}
