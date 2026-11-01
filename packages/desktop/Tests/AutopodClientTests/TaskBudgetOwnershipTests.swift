import AutopodClient
import AutopodDesktop
import Foundation
import Testing

@MainActor @Test(arguments: [false, true], [false, true])
func taskBudgetActionsRejectStaleConnection(raising: Bool, inFlight: Bool) async throws {
  try await withConfirmedActionFixture(initial: .failed) { fixture in
    let actions = fixture.handler.actions.taskBudget
    var failure: String?
    let operation: @MainActor () async -> Void = {
      do {
        if raising {
          _ = try await actions.raise(fixture.id, .init(tokenBudget: 300, expectedBudget: 100))
        } else {
          _ = try await actions.load(fixture.id)
        }
        Issue.record("An old connection must not authorize a budget action")
      } catch { failure = error.localizedDescription }
    }
    let replacement = DaemonAPI(
      baseURL: URL(string: "https://new-budget-owner.invalid")!, token: "new-owner")
    if inFlight {
      let task = fixture.start(operation)
      let request = try await fixture.peer.next()
      #expect(request.request.httpMethod == (raising ? "POST" : "GET"))
      #expect(
        request.request.url?.path == "/pods/\(fixture.id)/\(raising ? "budget" : "task-execution")")
      fixture.store.configure(api: replacement)
      request.respond(
        body: """
          {"taskId":"task","executionId":"execution","rootPodId":"root","podCount":2,
          "agentRunCount":1,"failedRunCount":0,"transientFailureCount":0,"providerAttemptCount":1,
          "validationExecutionCount":0,"tokenBudget":300,"recordedInputTokens":190,
          "recordedOutputTokens":10,"recordedTotalTokens":200,"recordedCostUsd":1.28,
          "telemetry":"partial","diagnostics":[]}
          """)
      await task.value
      #expect(fixture.peer.requests.count == 1)
    } else {
      fixture.store.configure(api: replacement)
      await fixture.start(operation).value
      #expect(fixture.peer.requests.isEmpty)
    }
    #expect(failure?.contains("Connection changed") == true)
  }
}
