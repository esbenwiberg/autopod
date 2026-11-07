import AutopodClient
import AutopodDesktop
import Foundation
import Testing

private func stalledRecoveryInput() -> StalledWorkerRecoveryRequest {
  .init(requestKey: "stable-key", expectedGeneration: 3, expectedBinding: String(repeating: "a", count: 64),
    reason: "Preserve recovered work")
}

private func stalledRecoveryReceiptJSON(podId: String, input: StalledWorkerRecoveryRequest) throws -> String {
  let json: [String: Any] = ["podId": podId, "request": try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)),
    "actor": ["type": "human", "userId": "fixture"], "state": "pending", "createdAt": "2026-11-05T12:00:00Z",
    "settledAt": NSNull(), "message": "Stop remains unconfirmed; resources retained", "resourcesRetained": true]
  return String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self)
}

@Test
func stalledWorkerRecoveryTransportUsesBoundEndpointAndPreservesPending() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [StalledWorkerRecoveryProtocol.self]
  let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
  let api = DaemonAPI(baseURL: URL(string: "https://stalled-worker-recovery.invalid")!, token: "synthetic", session: session)
  let view = try await api.inspectStalledWorkerRecovery("retained")
  #expect(view.generation == 3 && view.canStop && view.operation == nil)
  let request = stalledRecoveryInput()
  let first = try await api.recoverStalledWorker("retained", input: request)
  let replay = try await api.recoverStalledWorker("retained", input: request)
  #expect(first.request == request && replay.request == request)
  #expect(first.state == .pending && first.settledAt == nil && first.resourcesRetained)
  do {
    _ = try await api.inspectStalledWorkerRecovery("older")
    Issue.record("Unsupported daemon must fail closed")
  } catch DaemonError.notFound { }
  do {
    _ = try await api.recoverStalledWorker("refused", input: request)
    Issue.record("Daemon refusal must not become a success")
  } catch DaemonError.serverError(let code, _) { #expect(code == 409) }
}

@MainActor @Test(arguments: [false, true], [false, true])
func stalledWorkerRecoveryActionsRejectStaleConnection(submitting: Bool, inFlight: Bool) async throws {
  try await withConfirmedActionFixture(initial: .reviewRequired) { fixture in
    let actions = fixture.handler.actions.stalledWorkerRecovery
    // Avoid the automatic, immediate observation used by rendered detail fixtures.
    let id = submitting ? fixture.id : "held-stalledRecovery"
    var failure: String?
    let operation: @MainActor () async -> Void = {
      do {
        if submitting { _ = try await actions.submit(id, stalledRecoveryInput()) }
        else { _ = try await actions.load(id) }
        Issue.record("Old connection must not authorize stalledRecovery")
      } catch { failure = error.localizedDescription }
    }
    let replacement = DaemonAPI(baseURL: URL(string: "https://new-stalledRecovery-owner.invalid")!, token: "new-owner")
    if inFlight {
      let task = fixture.start(operation)
      let request = try await fixture.peer.next()
      #expect(request.request.httpMethod == (submitting ? "POST" : "GET"))
      #expect(request.request.url?.path == "/pods/\(id)/stalled-worker-recovery")
      fixture.store.configure(api: replacement)
      request.respond(body: submitting ? try stalledRecoveryReceiptJSON(podId: id, input: stalledRecoveryInput()) : """
        {"schemaVersion":1,"podId":"\(id)","generation":3,"status":"review_required","binding":"\(String(repeating: "a", count: 64))",
        "canStop":true,"blockers":[],"operation":null}
        """)
      await task.value
      #expect(fixture.peer.requests.count == 1)
    } else {
      fixture.store.configure(api: replacement)
      await fixture.start(operation).value
      #expect(fixture.peer.requests.isEmpty)
    }
    #expect(failure?.contains("Connection changed") == true)
    #expect(fixture.store.pods.isEmpty)
  }
}

@MainActor @Test func pendingStalledRecoveryDoesNotOptimisticallyKillOrDeletePod() async throws {
  try await withConfirmedActionFixture(initial: .reviewRequired) { fixture in
    let task = fixture.start {
      do {
        let receipt = try await fixture.handler.actions.stalledWorkerRecovery.submit(fixture.id, stalledRecoveryInput())
        #expect(receipt.state == .pending)
      } catch { Issue.record("Unexpected failure: \(error)") }
    }
    let request = try await fixture.peer.next()
    #expect(request.request.url?.path == "/pods/\(fixture.id)/stalled-worker-recovery")
    fixture.expectState(.reviewRequired)
    request.respond(body: try stalledRecoveryReceiptJSON(podId: fixture.id, input: stalledRecoveryInput()))
    await task.value
    fixture.expectState(.reviewRequired)
    #expect(fixture.peer.requests.count == 1)
  }
}

private final class StalledWorkerRecoveryProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "stalled-worker-recovery.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    #expect(request.url?.path.hasSuffix("/stalled-worker-recovery") == true)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
    let status: Int
    let body: String
    do {
      if request.url!.path.contains("/older/") { status = 404; body = #"{"error":"Unsupported API"}"# }
      else if request.url!.path.contains("/refused/") { status = 409; body = #"{"error":"Unsettled execution"}"# }
      else if request.httpMethod == "GET" {
        status = 200
        body = """
          {"schemaVersion":1,"podId":"retained","generation":3,"status":"review_required","binding":"\(String(repeating: "a", count: 64))",
          "canStop":true,"blockers":[],"operation":null}
          """
      } else {
        #expect(request.httpMethod == "POST")
        let data: Data
        if let value = request.httpBody { data = value }
        else if let stream = request.httpBodyStream {
          stream.open(); defer { stream.close() }
          var bytes = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
          while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.badServerResponse) }
            if count == 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
          }
          data = bytes
        } else { throw URLError(.badServerResponse) }
        let input = try JSONDecoder().decode(StalledWorkerRecoveryRequest.self, from: data)
        #expect(input == stalledRecoveryInput())
        let fields = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(Set(fields.keys) == ["requestKey", "expectedGeneration", "expectedBinding", "reason"])
        status = 200; body = try stalledRecoveryReceiptJSON(podId: "retained", input: input)
      }
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
