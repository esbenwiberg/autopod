import Foundation
import Testing
import AutopodClient
import AutopodDesktop
import AutopodUI

@MainActor @Test(arguments: ["success", "rejected", "lost-response"])
func approvalCoordinatesEntryPointsAndResets(outcome: String) async throws {
  try await withConfirmedActionFixture(initial: .validated) { fixture in
    let actions = fixture.handler.actions
    let task = fixture.start { await actions.approve(fixture.id, nil) }
    let post = try await fixture.peer.next()
    #expect(post.request.url?.path == "/pods/\(fixture.id)/approve")
    #expect(post.request.timeoutInterval == 300)
    #expect(actions.approvalPending(fixture.id))
    #expect(!actions.approvalPending("another-pod"))
    await fixture.handler.actions.approve(fixture.id, nil)
    #expect(fixture.peer.requests.count == 1)
    switch outcome {
    case "success": post.respond(body: #"{"ok":true}"#)
    case "rejected": post.respond(status: 409, body: #"{"error":"Approval is already in progress"}"#)
    default: post.fail(URLError(.networkConnectionLost))
    }
    await task.value
    #expect(!actions.approvalPending(fixture.id))
    #expect(fixture.handler.pendingAction == nil)
    fixture.expectState(.validated)
    if outcome == "lost-response" {
      #expect(fixture.handler.lastError?.contains("Approval is still running on the daemon or the connection dropped") == true)
    }
  }
}

@MainActor @Test func bulkApprovalMarksCardsAndPreventsRepeatedRequests() async throws {
  try await withConfirmedActionFixture(initial: .validated) { fixture in
    let task = fixture.start { await fixture.handler.approveAllValidated() }
    let request = try await fixture.peer.next()
    #expect(fixture.handler.actions.approvalPending(fixture.id))
    await fixture.handler.approveAllValidated()
    await fixture.handler.actions.approve(fixture.id, nil)
    #expect(fixture.peer.requests.count == 1)
    request.respond(status: 409, body: #"{"error":"Synthetic bulk rejection"}"#)
    await task.value
    #expect(!fixture.handler.actions.approvalPending(fixture.id))
    #expect(fixture.handler.pendingAction == nil)
    fixture.expectState(.validated)
  }
}
