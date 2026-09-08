import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor
@Test(arguments: ["resume", "validate", "revalidate"])
func unverifiedTerminationActionsRetainFailedState(action: String) async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [UnverifiedTerminationProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://termination-fixture.invalid")!, token: "synthetic",
    session: URLSession(configuration: configuration))
  let store = PodStore()
  store.upsertSession(Pod(id: action, status: .failed, branch: "retained", profileName: "test",
    model: "fixture", startedAt: Date()))
  let handler = ActionHandler(api: api, podStore: store, profileStore: ProfileStore())
  switch action {
  case "resume": await handler.resume(action)
  case "validate": await handler.rework(action)
  default: await handler.revalidate(action)
  }
  #expect(handler.lastError?.contains("unverified process termination") == true)
  #expect(handler.lastError?.contains("Retain its source and resources") == true)
  #expect(handler.lastError?.contains("{\"error\"") == false)
  #expect(handler.pendingAction == nil)
  #expect(store.pods.count == 1)
  #expect(store.pods.first?.id == action)
  #expect(store.pods.first?.status == .failed)
  #expect(store.pods.first?.branch == "retained")
}

private final class UnverifiedTerminationProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "termination-fixture.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let action = request.url!.pathComponents[2]
    #expect(request.httpMethod == "POST")
    #expect(request.url!.path == "/pods/\(action)/\(action)")
    let message = "A worker in this logical task has unverified process termination. Retain its source and resources; reconcile termination before Resume, Rework, validation or delivery."
    let payload = action == "resume"
      ? ["error": message, "code": "TASK_EXECUTION_TERMINATION_UNVERIFIED"]
      : ["error": "TASK_EXECUTION_TERMINATION_UNVERIFIED", "message": message]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 409,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
