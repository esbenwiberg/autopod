import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop

private func launchRequestBody(_ request: URLRequest) throws -> Data {
  if let body = request.httpBody { return body }
  let stream = try #require(request.httpBodyStream)
  stream.open(); defer { stream.close() }
  var bytes = Data()
  var buffer = [UInt8](repeating: 0, count: 1024)
  while true {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count == 0 { return bytes }
    if count < 0 { throw URLError(.badServerResponse) }
    bytes.append(contentsOf: buffer.prefix(count))
  }
}

@Suite @MainActor struct LaunchSelectionOwnershipTests {
  @Test func staleFleetOwnerCannotSubmitOrWriteAJournal() async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        let configuration = LaunchConfigurationStore(journalDirectory: root.appendingPathComponent("launches"))
        configuration.configure(api: f.apiA)
        let actions = configuration.actions(selectingIn: f.store)
        f.store.configure(api: f.apiB)
        var request = ComposableLaunchRequest(repositoryId: "repo", task: "Synthetic stale launch")
        request.requestId = UUID().uuidString
        do { _ = try await actions.launch(request); Issue.record("A stale fleet owner admitted a launch") }
        catch { #expect(error.localizedDescription.contains("Connection changed")) }
        #expect(f.a.requests.isEmpty && f.b.requests.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("launches").path))
      }
    }
  }
  @Test func enrolledRequestIsSentExactlyOnceEvenAfterLostReplyAndReopen() async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        let journal = root.appendingPathComponent("launches")
        let configuration = LaunchConfigurationStore(journalDirectory: journal)
        configuration.configure(api: f.apiA)
        let actions = configuration.actions(selectingIn: f.store)
        let request = try ComposableLaunchRequest.decodeJSON(Data(#"{"emptyWorkspace":true,"profileId":"fictional","task":"Fictional enrolled Task","intent":"task","requestId":"5ecff8d3-de82-48cb-961a-dc06dc506533","expectedDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","requireParentEnrollment":true}"#.utf8))
        let result = f.startResult {
          do { return try await actions.launch(request) } catch { return nil }
        }
        let post = try await f.a.next()
        #expect(post.request.httpMethod == "POST" && post.request.url?.path == "/pods")
        let wired = try launchRequestBody(post.request)
        #expect(try ComposableLaunchRequest.decodeJSON(wired) == request)
        let saved = journal.appendingPathComponent("5ecff8d3-de82-48cb-961a-dc06dc506533.json")
        #expect(try ComposableLaunchRequest.decodeJSON(Data(contentsOf: saved)) == request)
        try expectPrivateConnectionJournal(saved)
        post.respond(status: 503, body: #"{"error":"Launch result unavailable"}"#)
        #expect(await result.value == nil)

        let reopened = LaunchConfigurationStore(journalDirectory: journal)
        reopened.configure(api: f.apiA)
        do { _ = try await reopened.actions(selectingIn: f.store).launch(request); Issue.record("An enrolled launch was resent") }
        catch { #expect(error.localizedDescription.contains("already recorded")) }
        #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
      }
    }
  }
  @Test(arguments: ["discovery", "scores", "success", "read-failure", "same-endpoint", "pod-store-only"])
  func createdPodSelectionCannotEscapeItsConnection(stage: String) async throws {
    try await withPrivateConnectionJournal { root in
      try await withPodStoreLifetimeFixture { f in
        let configuration = LaunchConfigurationStore(journalDirectory: root.appendingPathComponent("launches"))
        configuration.configure(api: f.apiA)
        let actions = configuration.actions(selectingIn: f.store)
        var request = ComposableLaunchRequest(repositoryId: "repo", task: "Synthetic launch navigation")
        request.requestId = UUID().uuidString
        request.expectedDigest = String(repeating: "a", count: 64)
        let task = f.startResult {
          do { return try await actions.launch(request) } catch { return nil }
        }
        let post = try await f.a.next()
        #expect(post.request.httpMethod == "POST" && post.request.url?.path == "/pods")
        post.respond(body: lifetimePod(id: "created"))
        let discovery = try await f.next(f.a, "/pods")
        if ["discovery", "same-endpoint", "pod-store-only"].contains(stage) {
          let next = stage == "same-endpoint" ? f.apiA : f.apiB
          f.store.configure(api: next)
          if stage != "pod-store-only" { configuration.configure(api: next) }
          f.seed("replacement"); f.store.selectedSessionId = "replacement"
        }
        if stage == "read-failure" {
          discovery.respond(status: 503, body: #"{"error":"Discovery failed"}"#)
        } else { discovery.respond(body: lifetimePage(id: "created", hasNext: false)) }
        if !["discovery", "same-endpoint", "pod-store-only"].contains(stage) {
          let scores = try await f.next(f.a, "/pods/scores")
          if stage == "scores" {
            f.store.configure(api: f.apiB); configuration.configure(api: f.apiB)
            f.seed("replacement"); f.store.selectedSessionId = "replacement"
          }
          scores.respond(body: "[]")
        }
        let result = await task.value
        if ["success", "read-failure"].contains(stage) {
          #expect(result == "created")
          #expect(f.store.selectedSessionId == "created")
        } else {
          #expect(result == nil)
          #expect(f.store.selectedSessionId == "replacement")
          #expect(f.store.pods.map(\.id) == ["replacement"])
        }
        #expect(f.b.requests.isEmpty)
        let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("launches"), includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        try expectPrivateConnectionJournal(try #require(files.first))
      }
    }
  }
}
