import AutopodClient
@testable import AutopodDesktop
import Foundation
import Testing

@Suite(.serialized)
struct ManagedPodClientTests {
  @Test func apiTraversesManagedPodPages() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagedPodsURLProtocol.self]
    ManagedPodsURLProtocol.handler = { request in
      let hasCursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.contains(where: { $0.name == "cursor" }) == true
      let id = hasCursor ? "managed-older" : "managed-newer"
      let next = hasCursor ? "null" : #""101:managed-newer""#
      return Self.response(
        Self.page(id: id, nextCursor: next),
        for: request
      )
    }
    defer { ManagedPodsURLProtocol.handler = nil }

    let api = Self.api(configuration: configuration)
    let pods = try await api.listAllManagedPods(limit: 1)

    #expect(pods.map(\.id) == ["managed-newer", "managed-older"])
    #expect(pods.first?.providerAccountId == "openai-private")
    #expect(pods.first?.consumedTokens == 42)
  }

  @MainActor
  @Test func storeKeepsTheLastInventoryWhenRefreshFails() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagedPodsURLProtocol.self]
    ManagedPodsURLProtocol.handler = { request in
      Self.response(Self.page(id: "managed-one", nextCursor: "null"), for: request)
    }
    defer { ManagedPodsURLProtocol.handler = nil }

    let store = ManagedPodStore()
    store.configure(api: Self.api(configuration: configuration))
    await store.refresh()
    #expect(store.pods.map(\.id) == ["managed-one"])
    store.selectedPodId = "managed-one"

    ManagedPodsURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
    await store.refresh()

    #expect(store.pods.map(\.id) == ["managed-one"])
    #expect(store.selectedPodId == "managed-one")
    #expect(store.error != nil)

    store.configure(api: Self.api(configuration: configuration))
    #expect(store.pods.isEmpty)
    #expect(store.selectedPodId == nil)
    #expect(store.error == nil)
  }

  private static func api(configuration: URLSessionConfiguration) -> DaemonAPI {
    DaemonAPI(
      baseURL: URL(string: "https://managed-fixture.invalid")!,
      token: "token",
      session: URLSession(configuration: configuration)
    )
  }

  private static func response(_ body: String, for request: URLRequest) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    return (response, Data(body.utf8))
  }

  private static func page(id: String, nextCursor: String) -> String {
    """
    {"schemaVersion":1,"pods":[{
      "podId":"\(id)","dispatcherAttemptId":"attempt-\(id)","state":"running",
      "providerAccountId":"openai-private","model":"gpt-5.6-terra","runtime":"codex",
      "executionTarget":"sandbox","reasoning":"high","profileId":"dispatcher-research",
      "profileVersion":2,"providerRequests":1,"consumedTokens":42,"tokenUsageKnown":true,
      "failure":null,"limitations":[],"artifacts":[],"revoked":false,"stopRequested":false,
      "observedExit":false,"cleanup":"not-requested","exitCode":null,"createdAt":100,
      "lastEventAt":101
    }],"nextCursor":\(nextCursor)}
    """
  }
}

private final class ManagedPodsURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
  nonisolated(unsafe) static var handler: Handler?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}
