import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop

@Suite("EventStreamResyncTests")
struct EventStreamResyncTests {
  @MainActor
  @Test func replayTruncationReloadsSelectedPodLogs() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [EventStreamResyncURLProtocol.self]
    EventStreamResyncURLProtocol.handler = { request in
      let body: String
      if request.url?.path == "/pods/front-marlin/events" {
        body = """
        [{
          "eventId": 239,
          "type": "status",
          "timestamp": "2026-07-23T17:24:00Z",
          "message": "Pod complete"
        }]
        """
      } else {
        body = "[]"
      }
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      )!
      return (response, Data(body.utf8))
    }
    defer { EventStreamResyncURLProtocol.handler = nil }

    let api = DaemonAPI(
      baseURL: URL(string: "https://daemon.example.com")!,
      token: "test-token",
      session: URLSession(configuration: configuration)
    )
    let podStore = PodStore()
    podStore.configure(api: api)
    podStore.selectedSessionId = "front-marlin"
    let stream = EventStream(podStore: podStore)

    await stream.handleResyncRequired(api: api)

    #expect(stream.sessionEvents["front-marlin"]?.map(\.id) == [239])
    #expect(stream.sessionEvents["front-marlin"]?.first?.summary == "Pod complete")
  }
}

private final class EventStreamResyncURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) async throws -> (HTTPURLResponse, Data)

  nonisolated(unsafe) static var handler: Handler?

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

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
