import AutopodClient
import AutopodUI
import Foundation
import Testing
@testable import AutopodDesktop

private let fileManifest = """
{"version":1,"podId":"pod","generation":3,"sources":[{"id":"saved-workspace","kind":"saved","label":"Saved copy","binding":"\(String(repeating: "a", count: 64))","status":"available","detail":"May be older","files":[{"path":"src/a b.bin","size":1,"modified":0,"version":"\(String(repeating: "b", count: 64))"}],"truncated":false,"skippedEntries":0}],"limits":{"maxFileBytes":5242880,"maxSelectionBytes":52428800,"maxFiles":2000},"excludes":[".git"]}
"""
private let fileResponse = #"{"path":"src/a b.bin","size":1,"encoding":"base64","content":"AA==","sha256":"6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"}"#

@MainActor @Suite struct FileRecoveryTransportTests {
  @Test func sourceVersionAndGenerationAreExplicitAndOriginalInspectionIsOptIn() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let load = f.startResult {
        do { _ = try await handler.actions.fileRecovery.load("pod", false); return "listed" }
        catch { return error.localizedDescription }
      }
      let listing = try await f.a.next()
      #expect(listing.request.url?.path == "/pods/pod/file-recovery")
      #expect(listing.request.url?.query == nil || listing.request.url?.query == "")
      listing.respond(body: fileManifest)
      #expect(await load.value == "listed")
      let snapshot = try JSONDecoder().decode(RecoveryFilesSnapshot.self, from: Data(fileManifest.utf8))
      let selection = RecoveryFileSelection(source: snapshot.sources[0], generation: snapshot.generation, file: snapshot.sources[0].files[0])
      let read = f.startResult {
        do { let value = try await handler.actions.fileRecovery.read("pod", selection); return value.content }
        catch { return error.localizedDescription }
      }
      let request = try await f.a.next()
      let requestURL = try #require(request.request.url)
      let items = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false)?.queryItems)
      let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
      #expect(query == ["sourceId":"saved-workspace", "binding": selection.binding, "generation":"3", "path":"src/a b.bin", "version":selection.version])
      request.respond(body: fileResponse)
      #expect(await read.value == "AA==")
      let original = f.startResult {
        do { _ = try await handler.actions.fileRecovery.load("pod", true); return "original" }
        catch { return error.localizedDescription }
      }
      let explicit = try await f.a.next()
      #expect(explicit.request.url?.query == "original=1")
      explicit.respond(body: fileManifest)
      #expect(await original.value == "original")
      #expect(f.a.requests.count == 3 && f.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  @Test(arguments: [false, true], [200, 404, 409])
  func oldConnectionCannotSupplyListsBytesOrErrors(read: Bool, status: Int) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let snapshot = try JSONDecoder().decode(RecoveryFilesSnapshot.self, from: Data(fileManifest.utf8))
      let selection = RecoveryFileSelection(source: snapshot.sources[0], generation: 3, file: snapshot.sources[0].files[0])
      let task = f.startResult {
        do {
          if read { _ = try await handler.actions.fileRecovery.read("pod", selection) }
          else { _ = try await handler.actions.fileRecovery.load("pod", false) }
          return "unexpected success"
        } catch { return error.localizedDescription }
      }
      let held = try await f.a.next()
      f.store.configure(api: f.apiB); f.seed("pod", task: "new connection")
      held.respond(status: status, body: status == 200 ? (read ? fileResponse : fileManifest) : #"{"error":"old connection"}"#)
      #expect(await task.value?.contains("Connection changed") == true)
      #expect(f.b.requests.isEmpty && f.store.pods.first?.task == "new connection")
    }
  }
}
