import Foundation
import Testing
import AutopodUI

@MainActor @Test(arguments: ConfirmedAction.allCases)
func inlineBaselineDuplicatePosts(action: ConfirmedAction) async throws {
  try await withConfirmedActionFixture { fixture in
    let first = fixture.start(action)
    let firstPost = try await fixture.next("POST", action: action)
    let second = fixture.start(action)
    let secondPost = try await fixture.next("POST", action: action)
    #expect(fixture.peer.requests.count == 2)
    firstPost.respond(status: 409, body: #"{"error":"baseline rejection"}"#)
    secondPost.respond(status: 409, body: #"{"error":"baseline rejection"}"#)
    await first.value
    await second.value
  }
}

@MainActor @Test func inlineBaselineDeleteAfterFailedKill() async throws {
  try await withConfirmedActionFixture { fixture in
    // The current card's exact Void sequence, using real wired actions.
    let caller = Task {
      await fixture.handler.actions.kill(fixture.id)
      await fixture.handler.actions.delete(fixture.id)
    }
    let post = try await fixture.next("POST", action: .kill)
    post.respond(status: 409, body: #"{"error":"baseline rejection"}"#)
    let deletion = try await fixture.next("DELETE")
    #expect(fixture.handler.lastError != nil)
    deletion.respond(status: 409, body: #"{"error":"still active"}"#)
    await caller.value
    #expect(fixture.peer.requests.count == 2)
  }
}
