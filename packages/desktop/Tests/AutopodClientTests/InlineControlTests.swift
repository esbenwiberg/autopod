import Foundation
import Observation
import Testing
import AutopodUI
import AutopodDesktop

@MainActor final class InlineCallerState {
  var started = false
  var completed = false
}

@MainActor func inlineWait(_ predicate: () -> Bool) async throws {
  let deadline = ContinuousClock.now.advanced(by: .seconds(5))
  while !predicate() {
    guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
    try await Task.sleep(for: .milliseconds(2))
  }
}

@MainActor @Test(arguments: ConfirmedAction.allCases, ["success", "post-failure", "get-failure"])
func inlineControlJoinsDuplicate(action: ConfirmedAction, outcome: String) async throws {
  try await withConfirmedActionFixture { f in
    let first = InlineCallerState(), second = InlineCallerState()
    let one = f.start { await action.call(f.handler.actions, id: f.id); first.completed = true }
    let post = try await f.next("POST", action: action)
    let two = f.start {
      second.started = true
      await action.call(f.handler.actions, id: f.id)
      second.completed = true
    }
    try await inlineWait { second.started }
    #expect(!first.completed && !second.completed)
    #expect(f.peer.requests.count == 1)
    #expect(f.handler.actions.pendingControl(f.id) == (action == .pause ? .pause : .kill))
    f.expectState(.running)
    if outcome == "post-failure" {
      post.respond(status: 409, body: #"{"error":"control rejected"}"#)
    } else {
      post.respond(body: #"{"ok":true}"#)
      let get = try await f.next("GET")
      #expect(!first.completed && !second.completed)
      #expect(f.handler.actions.pendingControl(f.id) != nil)
      f.expectState(.running)
      if outcome == "get-failure" { get.respond(status: 503, body: #"{"error":"snapshot unavailable"}"#) }
      else { get.respond(body: f.snapshot(status: action == .pause ? .paused : .killed)) }
    }
    await one.value; await two.value
    #expect(first.completed && second.completed)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
    #expect(f.peer.requests.count == (outcome == "post-failure" ? 1 : 2))
    #expect((f.handler.lastError != nil) == (outcome == "post-failure"))
    if outcome != "success" { f.expectState(.running) }
  }
}

@MainActor @Test func inlineControlSeparatesPodsAndRejectsConflictingKind() async throws {
  try await withConfirmedActionFixture { f in
    let first = f.start(.pause)
    let pause = try await f.next("POST", action: .pause)
    await f.handler.actions.kill(f.id)
    await f.handler.actions.killAndDelete(f.id)
    #expect(f.peer.requests.count == 1)
    let other = f.start { await f.handler.actions.kill("other-pod") }
    let kill = try await f.peer.next()
    #expect(kill.request.url?.path == "/pods/other-pod/kill")
    #expect(f.handler.actions.pendingControl(f.id) == .pause)
    #expect(f.handler.actions.pendingControl("other-pod") == .kill)
    pause.respond(status: 409, body: #"{"error":"pause rejected"}"#)
    await first.value
    #expect(f.handler.actions.pendingControl(f.id) == nil)
    #expect(f.handler.actions.pendingControl("other-pod") == .kill)
    #expect(f.handler.pendingAction == "kill-other-pod")
    kill.respond(status: 409, body: #"{"error":"kill rejected"}"#)
    await other.value
    #expect(f.handler.actions.pendingControl("other-pod") == nil)
    #expect(f.peer.requests.count == 2)
  }
}

@MainActor @Test func inlineCombinedRejectsFailedKillWithoutDelete() async throws {
  try await withConfirmedActionFixture { f in
    let one = f.start { await f.handler.actions.killAndDelete(f.id) }
    let post = try await f.next("POST", action: .kill)
    #expect(f.handler.actions.pendingControl(f.id) == .killAndDelete)
    post.fail(URLError(.networkConnectionLost))
    await one.value
    #expect(f.peer.requests.count == 1)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
    #expect(f.handler.lastError != nil)
    f.expectState(.running)
  }
}

@MainActor @Test(arguments: [false, true])
func inlineCombinedJoinsExistingKillAndEntireDelete(refreshFails: Bool) async throws {
  try await withConfirmedActionFixture { f in
    let kill = f.start(.kill)
    let post = try await f.next("POST", action: .kill)
    let first = InlineCallerState(), second = InlineCallerState(), plain = InlineCallerState(), laterKill = InlineCallerState()
    let one = f.start { first.started = true; await f.handler.actions.killAndDelete(f.id); first.completed = true }
    try await inlineWait { first.started }
    let two = f.start { second.started = true; await f.handler.actions.killAndDelete(f.id); second.completed = true }
    try await inlineWait { second.started }
    #expect(f.peer.requests.count == 1)
    #expect(f.handler.actions.pendingControl(f.id) == .killAndDelete)
    post.respond(body: #"{"ok":true}"#)
    let get = try await f.next("GET")
    #expect(!first.completed && !second.completed)
    if refreshFails { get.respond(status: 503, body: #"{"error":"snapshot unavailable"}"#) }
    else { get.respond(body: f.snapshot(status: .killed)) }
    let deletion = try await f.next("DELETE")
    await kill.value
    #expect(f.handler.actions.pendingControl(f.id) == .killAndDelete)
    f.expectState(refreshFails ? .running : .killed)
    let three = f.start { plain.started = true; await f.handler.actions.delete(f.id); plain.completed = true }
    try await inlineWait { plain.started }
    let four = f.start { laterKill.started = true; await f.handler.actions.kill(f.id); laterKill.completed = true }
    try await inlineWait { laterKill.started }
    await f.handler.actions.pause(f.id)
    #expect(!first.completed && !second.completed && !plain.completed && !laterKill.completed)
    #expect(f.peer.requests.count == 3)
    deletion.respond(body: #"{"ok":true}"#)
    await one.value; await two.value; await three.value; await four.value
    #expect(first.completed && second.completed && plain.completed && laterKill.completed)
    #expect(f.store.pods.isEmpty)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
    #expect(f.peer.requests.count == 3)
  }
}

@MainActor @Test func inlineCombinedKeepsDeletionFailure() async throws {
  try await withConfirmedActionFixture { f in
    let task = f.start { await f.handler.actions.killAndDelete(f.id) }
    try await f.next("POST", action: .kill).respond(body: #"{"ok":true}"#)
    try await f.next("GET").respond(body: f.snapshot(status: .killed))
    try await f.next("DELETE").respond(status: 409, body: #"{"error":"owned resource remains"}"#)
    await task.value
    f.expectState(.killed)
    #expect(f.handler.lastError?.contains("owned resource remains") == true)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
  }
}

@MainActor @Test(arguments: ConfirmedAction.allCases, ["initiator-post", "joiner-post", "initiator-get", "joiner-get"])
func inlineControlCallerCancellationDoesNotCancelSharedRequest(action: ConfirmedAction, stage: String) async throws {
  try await withConfirmedActionFixture { f in
    let first = InlineCallerState(), second = InlineCallerState()
    let one = f.start { await action.call(f.handler.actions, id: f.id); first.completed = true }
    let post = try await f.next("POST", action: action)
    let two = f.start { second.started = true; await action.call(f.handler.actions, id: f.id); second.completed = true }
    try await inlineWait { second.started }
    if stage.hasSuffix("post") { (stage.hasPrefix("initiator") ? one : two).cancel() }
    #expect(!first.completed && !second.completed)
    post.respond(body: #"{"ok":true}"#)
    let get = try await f.next("GET")
    if stage.hasSuffix("get") { (stage.hasPrefix("initiator") ? one : two).cancel() }
    #expect(f.handler.actions.pendingControl(f.id) != nil)
    #expect(!first.completed && !second.completed)
    get.respond(body: f.snapshot(status: action == .pause ? .paused : .killed))
    await one.value; await two.value
    #expect(f.peer.requests.count == 2)
    #expect(f.handler.lastError == nil)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
  }
}

@MainActor @Test(arguments: [false, true])
func inlineCombinedCallerCancellationKeepsHeldDelete(cancelInitiator: Bool) async throws {
  try await withConfirmedActionFixture { f in
    let first = InlineCallerState(), second = InlineCallerState()
    let one = f.start { await f.handler.actions.killAndDelete(f.id); first.completed = true }
    try await f.next("POST", action: .kill).respond(body: #"{"ok":true}"#)
    try await f.next("GET").respond(body: f.snapshot(status: .killed))
    let deletion = try await f.next("DELETE")
    let two = f.start { second.started = true; await f.handler.actions.killAndDelete(f.id); second.completed = true }
    try await inlineWait { second.started }
    (cancelInitiator ? one : two).cancel()
    #expect(!first.completed && !second.completed)
    #expect(f.handler.actions.pendingControl(f.id) == .killAndDelete)
    deletion.respond(body: #"{"ok":true}"#)
    await one.value; await two.value
    #expect(f.peer.requests.count == 3)
    #expect(f.handler.actions.pendingControl(f.id) == nil)
    #expect(f.handler.lastError == nil)
  }
}

@MainActor @Test func inlineControlPreviewDefaults() async {
  #expect(PodActions.preview.pendingControl("pod") == nil)
  await PodActions.preview.killAndDelete("pod")
}

@MainActor private final class InlineErrorObserver {
  var publications = 0
  func observe(_ handler: ActionHandler) {
    withObservationTracking { _ = handler.lastError } onChange: {
      MainActor.assumeIsolated {
        self.publications += 1
        self.observe(handler)
      }
    }
  }
}

@MainActor @Test func inlineControlPublishesOneErrorForJoinedCallers() async throws {
  try await withConfirmedActionFixture { f in
    let observer = InlineErrorObserver()
    observer.observe(f.handler)
    let first = f.start(.kill)
    let post = try await f.next("POST", action: .kill)
    let joining = InlineCallerState()
    let second = f.start { joining.started = true; await f.handler.actions.kill(f.id) }
    try await inlineWait { joining.started }
    await f.handler.actions.pause(f.id)
    #expect(f.peer.requests.count == 1)
    post.respond(status: 409, body: #"{"error":"one shared error"}"#)
    await first.value; await second.value
    #expect(observer.publications == 1)
    #expect(f.handler.lastError?.contains("one shared error") == true)
    // Prove the observer remains armed for a subsequent independent publication.
    let third = f.start(.pause)
    try await f.next("POST", action: .pause).respond(status: 409, body: #"{"error":"second operation"}"#)
    await third.value
    #expect(observer.publications == 2)
  }
}
