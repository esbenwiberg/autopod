import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop

@MainActor @Suite struct ConnectionLaunchOwnershipTests {
  @Test(arguments: ["fork", "worker"], ["configuration", "resolve", "launch", "success"])
  func launchesFenceEachSuspensionAndKeepPrivateJournal(kind: String, stage: String) async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        f.seed("source", task: "Synthetic launch")
        let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore(), journalRoot: root)
        let task = f.startResult {
          if kind == "fork" { return await handler.forkSession("source") }
          return await handler.launchWorker("source", task: "Synthetic worker", brief: nil, sidecars: ["db"])
        }
        let configuration = try await f.next(f.a, "/pods/source/configuration")
        if stage == "configuration" { f.store.configure(api: f.apiB) }
        configuration.respond(body: connectionLaunchConfiguration)
        if stage != "configuration" {
          if kind == "worker" {
            let sync = try await f.a.next()
            #expect(sync.request.url?.path == "/pods/source/sync-branch")
            sync.respond(body: #"{"ok":true,"pushed":true}"#)
          }
          let resolve = try await f.a.next()
          #expect(resolve.request.url?.path == "/launch/resolve")
          if stage == "resolve" { f.store.configure(api: f.apiB) }
          resolve.respond(body: connectionLaunchConfiguration)
          if stage != "resolve" {
            let launch = try await f.a.next()
            #expect(launch.request.url?.path == "/pods")
            let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("launches"), includingPropertiesForKeys: nil)
            let journal = try #require(files.first)
            #expect(files.count == 1)
            let saved = try ComposableLaunchRequest.decodeJSON(Data(contentsOf: journal))
            #expect(saved.source?.configuration == (kind == "fork" ? "original" : "worker"))
            #expect(saved.source?.podId == "source")
            #expect(saved.expectedDigest == connectionDigest)
            #expect(saved.repositoryId == "repository")
            #expect(saved.work?["startBranch"]?.string == "B/branch")
            #expect(journal.lastPathComponent == "\(saved.requestId!).json")
            try expectPrivateConnectionJournal(journal)
            if stage == "launch" { f.store.configure(api: f.apiB); f.seed("created", task: "B owned") }
            launch.respond(body: lifetimePod(id: "created"))
          }
        }
        let result = await task.value
        if stage == "success" {
          #expect(result == "created" && f.store.pods.contains { $0.id == "created" && $0.task == "Full detail task" })
        } else {
          #expect(result == nil)
          #expect((kind == "fork" ? handler.lastError : handler.lastCreatePodError)?.contains("Connection changed") == true)
          if stage == "launch" { #expect(f.store.pods.first?.task == "B owned") }
          else { #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("launches").path)) }
        }
        let count = stage == "configuration" ? 1 : (kind == "worker" ? 1 : 0) + (stage == "resolve" ? 2 : 3)
        #expect(f.a.requests.count == count && f.b.requests.isEmpty)
      }
    }
  }

  @Test func workerCannotContinueAfterHeldBranchSync() async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        f.seed("source")
        let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore(), journalRoot: root)
        let task = f.startResult { await handler.launchWorker("source", task: "Worker", brief: nil, sidecars: nil) }
        try await f.a.next().respond(body: connectionLaunchConfiguration)
        let sync = try await f.a.next()
        f.store.disconnect()
        sync.respond(body: #"{"ok":true,"pushed":true}"#)
        #expect(await task.value == nil)
        #expect(f.a.requests.count == 2 && f.b.requests.isEmpty)
        let files = try FileManager.default.contentsOfDirectory(atPath: root.path); #expect(files.isEmpty)
      }
    }
  }

  @Test(arguments: ["obsolete", "held", "success"])
  func seriesJournalAndArrayPublicationFollowOwnership(stage: String) async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore(), journalRoot: root)
        let request = CreateSeriesRequest(requestId: "private-series", seriesName: "Synthetic", briefs: [], launch: [:])
        if stage == "obsolete" { f.store.disconnect() }
        let task = f.startResult { await handler.createSeries(request) }
        if stage != "obsolete" {
          let held = try await f.a.next()
          #expect(held.request.url?.path == "/pods/series")
          let journal = root.appendingPathComponent("series/private-series.json")
          let saved = try JSONDecoder().decode(CreateSeriesRequest.self, from: Data(contentsOf: journal))
          #expect(saved.requestId == request.requestId && saved.seriesName == request.seriesName)
          try expectPrivateConnectionJournal(journal)
          if stage == "held" { f.store.configure(api: f.apiB); f.seed("created", task: "B owned") }
          held.respond(body: lifetimeSeries("created"))
        }
        #expect(await task.value == (stage == "success" ? "series" : nil))
        #expect(f.a.requests.count == (stage == "obsolete" ? 0 : 1) && f.b.requests.isEmpty)
        if stage == "obsolete" { let files = try FileManager.default.contentsOfDirectory(atPath: root.path); #expect(files.isEmpty) }
        if stage == "held" { #expect(f.store.pods.first?.task == "B owned") }
        if stage == "success" { #expect(f.store.pods.first?.task == "Full detail task") }
      }
    }
  }

  @Test(arguments: ["fork", "worker"])
  func obsoleteLaunchCannotReadSourceOrWriteJournal(kind: String) async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        f.seed("source")
        let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore(), journalRoot: root)
        f.store.configure(api: f.apiA)
        let result = kind == "fork" ? await handler.forkSession("source") : await handler.launchWorker("source", task: "Worker", brief: nil, sidecars: nil)
        #expect(result == nil && f.a.requests.isEmpty)
        let files = try FileManager.default.contentsOfDirectory(atPath: root.path); #expect(files.isEmpty)
      }
    }
  }

  @Test func admittedTokenWaitMaySendButCannotPublishOrRefresh() async throws {
    let gate = SocketTokenGate()
    try await withPodStoreLifetimeFixture { f in
      let api = f.additionalAPI(for: f.a, tokenProvider: { await gate.token() })
      f.store.configure(api: api)
      let handler = ActionHandler(api: api, podStore: f.store, profileStore: ProfileStore())
      let task = f.start { await handler.reply("pod", message: "Admitted before disconnect") }
      do {
        try await gate.log.waitFor("entered")
        #expect(f.a.requests.isEmpty)
        f.store.configure(api: f.apiB); f.seed("pod", task: "B owned")
        gate.release()
        let admitted = try await f.a.next()
        #expect(admitted.request.httpMethod == "POST")
        admitted.respond(body: #"{"ok":true}"#)
        _ = await task.value
        #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
        #expect(f.store.pods.first?.task == "B owned")
        #expect(handler.lastError?.contains("Connection changed") == true)
      } catch { gate.release(); throw error }
    }
  }
}

let connectionDigest = String(repeating: "a", count: 64)
let connectionLaunchConfiguration = "{\"digest\":\"\(connectionDigest)\",\"repository\":{\"id\":\"repository\",\"setup\":{\"id\":\"setup\"}},\"profileId\":\"profile\"}"

@MainActor func withPrivateConnectionJournal(_ body: (URL) async throws -> Void) async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent("autopod-connection-journal-\(UUID())", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  try await body(directory)
}
func expectPrivateConnectionJournal(_ file: URL) throws {
  let fileMode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
  let folderMode = try FileManager.default.attributesOfItem(atPath: file.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
  #expect(fileMode?.intValue == 0o600 && folderMode?.intValue == 0o700)
}
