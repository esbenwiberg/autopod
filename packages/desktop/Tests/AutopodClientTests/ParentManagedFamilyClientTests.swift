import AutopodClient
import Foundation
import Testing

@Suite(.serialized)
struct ParentManagedFamilyClientTests {
  @Test func familyFixtureDecodesKnownAndFutureStatuses() throws {
    let family = try JSONDecoder().decode(
      ParentManagedFamily.self,
      from: Data(Self.familyFixture.utf8)
    )

    #expect(family.parent == "parent-one")
    #expect(family.run == "run-one")
    #expect(family.children.map(\.requestKey) == ["reserved-key", "started-key", "exited-key", "future-key"])
    #expect(family.children.map(\.parentAttempt) == ["attempt-1", "attempt-1", "attempt-2", "attempt-2"])
    #expect(family.children.map(\.child) == [nil, "child-started", "child-exited", "child-future"])
    #expect(family.children.map(\.status) == [.reserved, .started, .exited, .unknown])
  }

  @Test func fetchesFamilyFromBoundReadOnlyEndpoint() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      #expect(request.httpMethod == "GET")
      #expect(request.url?.path == "/orchestration/parents/parent-one/family")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
      return Self.response(status: 200, body: Self.familyFixture, request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }

    let family = try await Self.api(configuration: configuration)
      .getParentManagedFamily("parent-one")

    #expect(family?.run == "run-one")
    #expect(family?.children.last?.status == .unknown)
  }

  @Test(arguments: [401, 403, 404])
  func unavailableOrUnownedFamilyClearsAsNil(status: Int) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      Self.response(
        status: status,
        body: #"{"code":"parent-family-unavailable"}"#,
        request: request
      )
    }
    defer { ParentFamilyURLProtocol.handler = nil }

    let family = try await Self.api(configuration: configuration)
      .getParentManagedFamily("parent-one")

    #expect(family == nil)
  }

  @Test func realServerFailureStillThrows() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      Self.response(status: 500, body: #"{"message":"database unavailable"}"#, request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }

    do {
      _ = try await Self.api(configuration: configuration)
        .getParentManagedFamily("parent-one")
      Issue.record("Expected the server failure to be preserved")
    } catch DaemonError.serverError(let status, let message) {
      #expect(status == 500)
      #expect(message == "database unavailable")
    }
  }

  @Test func rejectsFamilyBoundToAnotherParent() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      let body = Self.familyFixture.replacingOccurrences(of: "parent-one", with: "parent-two")
      return Self.response(status: 200, body: body, request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }

    do {
      _ = try await Self.api(configuration: configuration)
        .getParentManagedFamily("parent-one")
      Issue.record("Expected a mismatched parent response to be rejected")
    } catch DaemonError.decodingError(let message) {
      #expect(message.contains("requested parent"))
    }
  }

  @Test(arguments: ["parent/one", "parent-one\n"])
  func invalidParentIdIsRejectedBeforeTransport(id: String) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      Issue.record("Invalid IDs must not reach the transport")
      return Self.response(status: 200, body: Self.familyFixture, request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }

    do {
      _ = try await Self.api(configuration: configuration)
        .getParentManagedFamily(id)
      Issue.record("Expected invalid parent ID rejection")
    } catch DaemonError.badRequest(let message) {
      #expect(message == "Invalid parent pod ID")
    }
  }

  private static func api(configuration: URLSessionConfiguration) -> DaemonAPI {
    DaemonAPI(
      baseURL: URL(string: "https://parent-family-fixture.invalid")!,
      token: "token",
      session: URLSession(configuration: configuration)
    )
  }

  private static func response(
    status: Int,
    body: String,
    request: URLRequest
  ) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    return (response, Data(body.utf8))
  }

  private static let familyFixture = """
  {
    "parent": "parent-one",
    "run": "run-one",
    "children": [
      {"requestKey":"reserved-key","parentAttempt":"attempt-1","child":null,"status":"reserved"},
      {"requestKey":"started-key","parentAttempt":"attempt-1","child":"child-started","status":"started"},
      {"requestKey":"exited-key","parentAttempt":"attempt-2","child":"child-exited","status":"exited"},
      {"requestKey":"future-key","parentAttempt":"attempt-2","child":"child-future","status":"future-state"}
    ]
  }
  """
}

private final class ParentFamilyURLProtocol: URLProtocol, @unchecked Sendable {
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
