import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor
@Test(arguments: ["resume", "validate", "revalidate", "delete", "delete-cleanup"])
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
  case "delete", "delete-cleanup": await handler.deletePod(action)
  default: await handler.revalidate(action)
  }
  let expected = action == "delete-cleanup" ? "deletion cleanup is unverified" : (action == "delete" ? "unsettled worker execution" : "unverified process termination")
  #expect(handler.lastError?.contains(expected) == true)
  #expect(handler.lastError?.contains(action == "delete-cleanup" ? "reconcile resource and pod state" : "Retain its source and resources") == true)
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
    let deleting = action.hasPrefix("delete")
    #expect(request.httpMethod == (deleting ? "DELETE" : "POST"))
    #expect(request.url!.path == (deleting ? "/pods/\(action)" : "/pods/\(action)/\(action)"))
    let message = action == "delete-cleanup"
      ? "Pod deletion cleanup is unverified at sidecars. Delete was not completed by this cleanup; reconcile resource and pod state before retrying."
      : action == "delete"
      ? "This logical task has an unsettled worker execution. Retain its source and resources; reconcile the execution before deleting a pod or its task evidence."
      : "A worker in this logical task has unverified process termination. Retain its source and resources; reconcile termination before Resume, Rework, validation or delivery."
    let payload = action == "resume"
      ? ["error": message, "code": "TASK_EXECUTION_TERMINATION_UNVERIFIED"]
      : ["error": action == "delete-cleanup" ? "POD_DELETE_CLEANUP_UNVERIFIED" : (action == "delete" ? "TASK_EXECUTION_UNSETTLED" : "TASK_EXECUTION_TERMINATION_UNVERIFIED"), "message": message]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 409,
      httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
