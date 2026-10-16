import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@MainActor func connectionWait(_ condition: () -> Bool) async throws {
  let deadline = ContinuousClock.now.advanced(by: .seconds(5))
  while !condition() {
    guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
    try await Task.sleep(for: .milliseconds(2))
  }
}

@MainActor @Suite struct ConnectionOwnershipTests {
  @Test func replacementClearsCachedSource() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("pod", task: "A")
      f.store.selectedSessionId = "pod"
      let diff = f.start { await f.store.loadDiff("pod") }
      try await f.next(f.a, "/pods/pod/diff").respond(body: lifetimeDiff("A"))
      _ = await diff.value
      let scores = f.start { await f.store.loadQualityScores() }
      try await f.next(f.a, "/pods/scores").respond(body: lifetimeScores("pod"))
      _ = await scores.value
      let series = f.start { _ = await f.store.loadSeries("series") }
      try await f.next(f.a, "/pods/series/series").respond(body: lifetimeSeries("A"))
      _ = await series.value
      f.store.configure(api: f.apiB)
      #expect(f.store.pods.isEmpty)
      #expect(f.store.selectedSessionId == nil)
      #expect(f.store.sessionDiffs.isEmpty)
      #expect(f.store.qualityScores.isEmpty)
      #expect(f.store.seriesCache.isEmpty)
    }
  }

  @Test(arguments: [false, true])
  func obsoleteResponseCannotMutateReplacement(deleting: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.start {
        if deleting { await handler.deletePod("pod") }
        else { _ = await handler.fixManually("pod") }
      }
      let response = try await f.a.next()
      #expect(response.request.httpMethod == (deleting ? "DELETE" : "POST"))
      f.store.configure(api: f.apiB)
      f.seed("pod", task: "B")
      response.respond(body: deleting ? #"{"ok":true}"# : lifetimePod(id: "pod"))
      _ = await task.value
      #expect(f.store.pods.first?.task == "B")
    }
  }

  @Test func obsoleteAcknowledgementCannotRefreshReplacement() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      var finished = false
      let task = f.start { await handler.reply("pod", message: "A reply"); finished = true }
      let post = try await f.a.next()
      f.store.configure(api: f.apiB)
      post.respond(body: #"{"ok":true}"#)
      try await connectionWait { finished || !f.b.requests.isEmpty }
      if !f.b.requests.isEmpty { try await f.b.next().fail(URLError(.cannotConnectToHost)) }
      _ = await task.value
      #expect(f.b.requests.isEmpty)
    }
  }

  @Test func obsoleteHandlerCannotAdmitWork() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      f.store.configure(api: f.apiB)
      var finished = false
      let task = f.start { await handler.approve("pod"); finished = true }
      try await connectionWait { finished || !f.a.requests.isEmpty }
      if !f.a.requests.isEmpty { try await f.a.next().respond(body: #"{"ok":true}"#) }
      _ = await task.value
      #expect(f.a.requests.isEmpty)
    }
  }
}
