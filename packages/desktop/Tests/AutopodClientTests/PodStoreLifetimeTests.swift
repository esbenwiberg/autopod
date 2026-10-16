import Foundation
import Testing
import AutopodClient
import AutopodDesktop

@Suite("PodStoreLifetimeTests") @MainActor
struct PodStoreLifetimeTests {
  @Test(arguments: [false, true], [false, true])
  func supersededListCannotPublishOrStartFollowups(fails: Bool, bHeld: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      let old = f.start { await f.store.loadSessions() }
      let aList = try await f.next(f.a, "/pods")
      f.store.configure(api: f.apiB)
      #expect(!f.store.isLoading)
      #expect(f.store.error == nil)
      let current = f.start { await f.store.loadSessions() }
      try await f.finishList(f.b, task: current, id: "B")
      f.store.selectedSessionId = "B"
      let currentAgain = f.start { await f.store.loadSessions() }
      let bList = try await f.next(f.b, "/pods")
      if !bHeld {
        bList.respond(status: 503, body: #"{"error":"B unavailable"}"#)
        try await f.next(f.b, "/pods/scores").respond(body: "[]")
        _ = await currentAgain.value
        #expect(f.store.error?.contains("B unavailable") == true)
      }
      let expectedError = f.store.error
      let bRequestCount = f.b.requests.count
      if fails { aList.respond(status: 503, body: #"{"error":"A unavailable"}"#) }
      else { aList.respond(body: lifetimePage(id: "A", hasNext: false)) }
      _ = await old.value
      #expect(f.store.pods.map(\.id) == ["B"])
      #expect(f.store.selectedSessionId == "B")
      #expect(f.store.error == expectedError)
      #expect(f.store.isLoading == bHeld)
      #expect(f.b.requests.count == bRequestCount)
      if bHeld {
        bList.respond(body: lifetimePage(id: "B", hasNext: false))
        try await f.next(f.b, "/pods/scores").respond(body: "[]")
        _ = await currentAgain.value
        #expect(!f.store.isLoading)
      }
    }
  }

  @Test(arguments: [false, true])
  func supersededDetailCannotOverwriteAppendOrHydrate(sameID: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      let old = f.start { await f.store.refreshSession("pod") }
      let response = try await f.next(f.a, "/pods/pod")
      f.store.configure(api: f.apiB)
      if sameID { f.seed("pod") }
      response.respond(body: lifetimePod(id: "pod"))
      _ = await old.value
      #expect(f.store.pods.count == (sameID ? 1 : 0))
      if sameID { #expect(f.store.pods.first?.task == "B detail") }
      let hydrate = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      try await f.next(f.b, "/pods/pod").respond(body: lifetimePod(id: "pod"))
      _ = await hydrate.value
      #expect(f.store.pods.first?.task == "Full detail task")
    }
  }

  @Test(arguments: ["scores", "series", "diff", "empty-diff"])
  func supersededCachesCannotReplaceCurrent(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let path = kind == "scores" ? "/pods/scores" : kind == "series" ? "/pods/series/series" : "/pods/pod/diff"
      @MainActor func start() -> Task<String?, Never> {
        f.startResult {
          switch kind {
          case "scores": await f.store.loadQualityScores()
          case "series": return await f.store.loadSeries("series")?.seriesName
          default: await f.store.loadDiff("pod")
          }
          return nil
        }
      }
      func payload(_ name: String) -> String {
        switch kind {
        case "scores": return lifetimeScores(name)
        case "series": return lifetimeSeries(name)
        default: return lifetimeDiff(name == "A" && kind == "empty-diff" ? nil : name)
        }
      }
      let old = start()
      let a = try await f.next(f.a, path)
      f.store.configure(api: f.apiB)
      let current = start()
      try await f.next(f.b, path).respond(body: payload("B"))
      let currentResult = await current.value
      if kind == "series" { #expect(currentResult == "B") }
      a.respond(body: payload("A"))
      #expect(await old.value == nil)
      switch kind {
      case "scores": #expect(Set(f.store.qualityScores.keys) == ["B"])
      case "series":
        #expect(f.store.seriesCache["series"]?.seriesName == "B")
        #expect(f.store.pods.map(\.id) == ["B"])
      default: #expect(f.store.sessionDiffs["pod"]?.files.first?.path == "B")
      }
      // Current failures preserve cached values; current empty diff removes its cache.
      let failed = start()
      try await f.next(f.b, path).respond(status: 503, body: #"{"error":"current failed"}"#)
      #expect(await failed.value == nil)
      switch kind {
      case "scores": #expect(Set(f.store.qualityScores.keys) == ["B"])
      case "series": #expect(f.store.seriesCache["series"]?.seriesName == "B")
      default:
        #expect(f.store.sessionDiffs["pod"]?.files.first?.path == "B")
        let empty = start()
        try await f.next(f.b, path).respond(body: lifetimeDiff(nil))
        _ = await empty.value
        #expect(f.store.sessionDiffs["pod"] == nil)
      }
    }
  }

  @Test func hydrationAdmissionBelongsToItsConfiguration() async throws {
    try await withPodStoreLifetimeFixture { f in
      let old = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      let a = try await f.next(f.a, "/pods/pod")
      f.store.configure(api: f.apiB)
      let current = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      let b = try await f.next(f.b, "/pods/pod")
      a.fail(URLError(.networkConnectionLost))
      _ = await old.value
      await f.store.hydrateSessionIfNeeded("pod")
      #expect(f.b.requests.count == 1)
      b.respond(body: lifetimePod(id: "pod"))
      _ = await current.value
      await f.store.hydrateSessionIfNeeded("pod")
      #expect(f.b.requests.count == 1)
      // Same API object still starts a new epoch and permits fresh detail loading.
      f.store.configure(api: f.apiB)
      let failed = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      try await f.next(f.b, "/pods/pod").fail(URLError(.networkConnectionLost))
      _ = await failed.value
      let retry = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      try await f.next(f.b, "/pods/pod").respond(body: lifetimePod(id: "pod"))
      _ = await retry.value
      #expect(f.b.requests.count == 3)
    }
  }

  @Test func listRechecksOwnershipAfterNestedHydration() async throws {
    try await withPodStoreLifetimeFixture { f in
      let initial = f.start { await f.store.hydrateSessionIfNeeded("pod") }
      try await f.next(f.a, "/pods/pod").respond(body: lifetimePod(id: "pod"))
      _ = await initial.value
      f.store.selectedSessionId = "pod"
      let old = f.start { await f.store.loadSessions() }
      try await f.next(f.a, "/pods").respond(body:
        lifetimePage(id: "pod", hasNext: false, updatedAt: "2026-07-01T00:20:00Z"))
      let nested = try await f.next(f.a, "/pods/pod")
      f.store.configure(api: f.apiB)
      #expect(!f.store.isLoading)
      #expect(f.store.error == nil)
      let current = f.start { await f.store.loadSessions() }
      let b = try await f.next(f.b, "/pods")
      nested.respond(body: lifetimePod(id: "pod"))
      _ = await old.value
      #expect(f.store.isLoading)
      #expect(f.b.requests.count == 1)
      b.respond(body: lifetimePage(id: "B", hasNext: false))
      try await f.next(f.b, "/pods/scores").respond(body: "[]")
      _ = await current.value
      #expect(f.store.pods.map(\.id) == ["B"])
    }
  }

  @Test func returningToSameAPIObjectDoesNotReviveOldWork() async throws {
    try await withPodStoreLifetimeFixture { f in
      let old = f.start { await f.store.refreshSession("pod") }
      let a = try await f.next(f.a, "/pods/pod")
      f.store.configure(api: f.apiB)
      f.store.configure(api: f.apiA)
      f.seed("pod")
      a.respond(body: lifetimePod(id: "pod"))
      _ = await old.value
      #expect(f.store.pods.first?.task == "B detail")
    }
  }

  @Test func fixtureReleasesHeldRequestsOnFailure() async throws {
    enum Expected: Error { case stop }
    do {
      try await withPodStoreLifetimeFixture { f in
        _ = f.start { await f.store.refreshSession("pod") }
        _ = try await f.next(f.a, "/pods/pod")
        throw Expected.stop
      }
      Issue.record("Expected fixture body failure")
    } catch Expected.stop {}
  }
}
