import AutopodClient
import CryptoKit
import Foundation
import Testing

@Suite(.serialized)
struct ParentManagedFamilyClientTests {
  @Test func familyFixtureDecodesKnownAndFutureStatuses() throws {
    let family = try JSONDecoder().decode(
      ParentManagedFamily.self,
      from: Data(Self.familyFixture.utf8)
    )

    #expect(family.review == nil) // Older daemons omit the optional projection.
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

  @Test func onlyExactParentBundleIsApprovedAndDownloaded() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      let selection = Self.bundleSelection
      let prefix = "/orchestration/parents/parent-one/review/\(selection.evidenceDigest)"
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
      switch request.url?.path {
      case prefix + "/preview":
        #expect(request.httpMethod == "GET")
        return Self.response(status: 200, body: Self.reviewFixture, request: request)
      case prefix + "/approve":
        #expect(request.httpMethod == "POST")
        let decision = try JSONDecoder().decode([String: String].self, from: Self.requestBody(request))
        #expect(decision == ["evidenceDigest": selection.evidenceDigest, "expectedReviewDigest": Self.receipt("d")])
        return Self.response(status: 200, body: Self.approvalFixture, request: request)
      case prefix + "/bundle":
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/octet-stream")
        return Self.bundleResponse(request)
      default:
        throw URLError(.badURL)
      }
    }
    defer { ParentFamilyURLProtocol.handler = nil }
    let api = Self.api(configuration: configuration)
    let selection = Self.bundleSelection
    let review = try await api.previewParentBundle(selection)
    let approval = try await api.approveParentBundle(selection, review: review)
    #expect(approval.review == review)
    #expect(try await api.downloadParentBundle(selection, approval: approval) == Self.bundle)
  }

  @Test(arguments: ["parent-one", "run-one", "evidence", "bundle"])
  func mismatchedOrMalformedPreviewIsRefused(field: String) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    let needle = field == "evidence" ? Self.bundleSelection.evidenceDigest
      : field == "bundle" ? Self.bundleDigest : field
    ParentFamilyURLProtocol.handler = { request in
      Self.response(status: 200, body: Self.reviewFixture.replacingOccurrences(of: needle, with: "wrong"), request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }
    await #expect(throws: URLError.self) {
      try await Self.api(configuration: configuration).previewParentBundle(Self.bundleSelection)
    }
  }

  @Test func approvalReceiptMustMatchTheEntirePreview() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      Self.response(status: 200, body: Self.approvalFixture.replacingOccurrences(of: "sample/count.txt", with: "sample/other.txt"), request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }
    let review = try JSONDecoder().decode(ParentBundleReview.self, from: Data(Self.reviewFixture.utf8))
    await #expect(throws: URLError.self) {
      try await Self.api(configuration: configuration).approveParentBundle(Self.bundleSelection, review: review)
    }
  }

  @Test(arguments: ["bytes", "header", "mime", "length", "not-approved", "wrong-owner"])
  func rejectsUnverifiedOrUnauthorizedDownload(kind: String) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      switch kind {
      case "not-approved": return Self.response(status: 409, body: "{}", request: request)
      case "wrong-owner": return Self.response(status: 404, body: "{}", request: request)
      default: return Self.bundleResponse(request, corrupt: kind)
      }
    }
    defer { ParentFamilyURLProtocol.handler = nil }
    let approval = try JSONDecoder().decode(ParentBundleApproval.self, from: Data(Self.approvalFixture.utf8))
    await #expect(throws: (any Error).self) {
      try await Self.api(configuration: configuration).downloadParentBundle(Self.bundleSelection, approval: approval)
    }
  }

  @MainActor @Test func admitsNoApprovalTransportAfterOwnerChangesDuringTokenRefresh() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ParentFamilyURLProtocol.self]
    ParentFamilyURLProtocol.handler = { request in
      Issue.record("Approval must not reach the transport after the owner changes")
      return Self.response(status: 200, body: Self.approvalFixture, request: request)
    }
    defer { ParentFamilyURLProtocol.handler = nil }
    let scope = OwnerScope()
    let api = DaemonAPI(baseURL: URL(string: "https://parent-family-fixture.invalid")!, initialToken: "token",
      session: URLSession(configuration: configuration), tokenProvider: {
        await scope.invalidate()
        return "new-token"
      })
    let review = try JSONDecoder().decode(ParentBundleReview.self, from: Data(Self.reviewFixture.utf8))
    await #expect(throws: CancellationError.self) {
      try await api.approveParentBundle(Self.bundleSelection, review: review) {
        if !scope.current { throw CancellationError() }
      }
    }
  }

  @MainActor private final class OwnerScope {
    var current = true
    func invalidate() { current = false }
  }

  private static func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 512)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else { throw URLError(.cannotDecodeContentData) }
      if count == 0 { return body }
      body.append(contentsOf: buffer.prefix(count))
    }
  }

  private static let bundle = Data("fixture bundle bytes".utf8)
  private static var bundleDigest: String {
    "sha256:" + SHA256.hash(data: bundle).map { String(format: "%02x", $0) }.joined()
  }
  private static func receipt(_ char: String) -> String { "sha256:" + String(repeating: char, count: 64) }
  private static let bundleSelection = ParentBundleSelection(parentId: "parent-one", run: "run-one",
    evidenceDigest: receipt("a"), commit: String(repeating: "b", count: 40))!
  private static var reviewFixture: String {
    """
    {"parentId":"parent-one","run":"run-one","evidenceDigest":"\(bundleSelection.evidenceDigest)",
    "commit":"\(bundleSelection.commit)","tree":"\(String(repeating: "c", count: 40))","bundleDigest":"\(bundleDigest)",
    "paths":["sample/count.txt"],"checks":"\(receipt("1"))","independentReview":"\(receipt("2"))","reviewDigest":"\(receipt("d"))"}
    """
  }
  private static var approvalFixture: String {
    """
    {"review":\(reviewFixture),"approvalDigest":"\(receipt("e"))","approvedAt":1795375100}
    """
  }
  private static func bundleResponse(_ request: URLRequest, corrupt: String? = nil) -> (HTTPURLResponse, Data) {
    var headers = ["Content-Type": corrupt == "mime" ? "text/plain" : "application/octet-stream",
      "X-Autopod-Bundle-Digest": corrupt == "header" ? receipt("f") : bundleDigest]
    if corrupt == "length" { headers["Content-Length"] = String(64 * 1024 * 1024 + 1) }
    return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!,
      corrupt == "bytes" ? Data("different bundle".utf8) : bundle)
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
