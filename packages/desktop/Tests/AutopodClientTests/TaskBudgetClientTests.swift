import Foundation
import Testing

@testable import AutopodClient

@Test(arguments: [false, true])
func taskBudgetClientUsesTaskLedgerAndExplicitNulls(unlimited: Bool) async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [TaskBudgetFixtureProtocol.self]
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let api = DaemonAPI(
    baseURL: URL(string: "https://task-budget-fixture.invalid")!,
    token: "synthetic", session: session)
  let id = unlimited ? "remove" : "raise"
  let current = try await api.getTaskExecution(id)
  #expect(current.tokenBudget == 100)
  #expect(current.rootPodId == "root")
  #expect(current.podCount == 2)
  let updated = try await api.raiseTaskBudget(
    id,
    request: .init(
      tokenBudget: unlimited ? nil : 300, expectedBudget: current.tokenBudget))
  #expect(updated.tokenBudget == (unlimited ? nil : 300))
  #expect(updated.recordedTotalTokens == 200)
}

@Test func taskBudgetRequestEncodesUnlimitedExpectedBudget() throws {
  let data = try JSONEncoder().encode(
    TaskBudgetChangeRequest(tokenBudget: nil, expectedBudget: nil))
  let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  #expect(object.count == 2)
  #expect(object["tokenBudget"] is NSNull)
  #expect(object["expectedBudget"] is NSNull)
}

@Test func taskBudgetClientSurfacesOptimisticConflict() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [TaskBudgetFixtureProtocol.self]
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let api = DaemonAPI(
    baseURL: URL(string: "https://task-budget-fixture.invalid")!,
    token: "synthetic", session: session)
  do {
    _ = try await api.raiseTaskBudget(
      "conflict", request: .init(tokenBudget: 300, expectedBudget: 100))
    Issue.record("Expected budget conflict")
  } catch {
    #expect(error.localizedDescription.contains("Task budget changed; refresh and try again"))
  }
}

private final class TaskBudgetFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "task-budget-fixture.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
    let budget: String
    if request.httpMethod == "GET" {
      #expect(path.hasSuffix("/task-execution"))
      budget = "100"
    } else {
      #expect(request.httpMethod == "POST")
      #expect(path.hasSuffix("/budget"))
      let data: Data
      if let body = request.httpBody {
        data = body
      } else {
        let stream = request.httpBodyStream!
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          body.append(contentsOf: buffer.prefix(count))
        }
        data = body
      }
      let input = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      #expect(input.count == 2)
      #expect(input["expectedBudget"] as? Int == 100)
      if path.contains("/remove/") {
        #expect(input["tokenBudget"] is NSNull)
        budget = "null"
      } else {
        #expect(input["tokenBudget"] as? Int == 300)
        budget = "300"
      }
    }
    let conflict = path.contains("/conflict/")
    let body =
      conflict
      ? #"{"error":"TASK_BUDGET_CHANGED","message":"Task budget changed; refresh and try again"}"#
      : """
      {"taskId":"task","executionId":"execution","rootPodId":"root","podCount":2,
      "agentRunCount":1,"failedRunCount":0,"transientFailureCount":0,"providerAttemptCount":1,
      "validationExecutionCount":0,"tokenBudget":\(budget),"recordedInputTokens":190,
      "recordedOutputTokens":10,"recordedTotalTokens":200,"recordedCostUsd":1.28,
      "telemetry":"partial","diagnostics":[]}
      """
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: conflict ? 409 : 200,
        httpVersion: nil, headerFields: ["Content-Type": "application/json"])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
