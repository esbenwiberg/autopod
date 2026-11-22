import AutopodClient
import AutopodDesktop
import Foundation
import Testing
@testable import AutopodUI

private func cleanupPlanData() throws -> Data {
  try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/retained-cleanup-v1.json"))
}

private func cleanupReceipt(_ podId: String, _ input: RetainedCleanupRequest, _ state: String,
  wrongResource: Bool = false) throws -> String {
  let plan = try JSONSerialization.jsonObject(with: cleanupPlanData()) as! [String: Any]
  let targets = plan["resources"] as! [[String: String]]
  var progress = targets.enumerated().map { index, resource in
    resource.merging(["state": state == "deleted" ? "confirmed_absent" :
      (index == 0 ? "removal_unconfirmed" : "pending")]) { _, new in new }
  }
  if wrongResource { progress[0]["id"] = "wrong-exact-id" }
  let json: [String: Any] = ["podId": podId, "request": try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)),
    "actor": ["type": "human", "userId": "exact-operator"], "state": state, "plan": plan, "resources": progress,
    "createdAt": "2026-11-19T10:00:00.000Z", "updatedAt":"2026-11-19T10:00:00.000Z", "blockers": []]
  return String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self)
}

private func cleanupBody(_ request: URLRequest) throws -> Data {
  if let body = request.httpBody { return body }
  let stream = try #require(request.httpBodyStream)
  stream.open(); defer { stream.close() }
  var bytes = Data()
  var buffer = [UInt8](repeating: 0, count: 1024)
  while stream.hasBytesAvailable {
    let size = stream.read(&buffer, maxLength: buffer.count)
    if size < 0 { throw stream.streamError ?? URLError(.badServerResponse) }
    if size == 0 { break }
    bytes.append(contentsOf: buffer.prefix(size))
  }
  return bytes
}

@MainActor @Test func retainedCleanupTransportJournalsBeforeOnePostAndOnlyExactDeletedRemovesRow() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: directory) }
  try await withConfirmedActionFixture(initial: .reviewRequired, journalRoot: directory) { f in
    var row = try #require(f.store.selectedSession)
    row.executionTarget = "local"
    row.hasWorktree = true
    row.retainedDockerCustody = true
    f.store.upsertSession(row)
    await f.handler.actions.kill(f.id)
    await f.handler.actions.killAndDelete(f.id)
    await f.handler.actions.delete(f.id)
    #expect(f.peer.requests.isEmpty)
    #expect(f.handler.lastError?.contains("Do not use ordinary Kill or Delete") == true)
    let actions = f.handler.actions.retainedCleanup
    let model = RetainedCleanupModel(podId: f.id, actions: actions)
    let task = f.start { await model.refresh(actions) }
    let preview = try await f.peer.next()
    #expect(preview.request.httpMethod == "GET" && preview.request.url?.path == "/pods/\(f.id)/retained-cleanup")
    let plan = String(decoding: try cleanupPlanData(), as: UTF8.self)
    preview.respond(body: #"{"podId":"\#(f.id)","state":"eligible","plan":\#(plan)}"#)
    await task.value
    let reviewed = try #require(model.plan)
    model.reason = "   Discard the unpublished experiment   "; model.acknowledgesLoss = true
    let send = f.start { await model.apply(reviewed: reviewed, actions: actions) }
    let post = try await f.peer.next()
    #expect(post.request.httpMethod == "POST" && post.request.url?.path == preview.request.url?.path)
    #expect(post.request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-action-token")
    let body = try cleanupBody(post.request)
    let input = try JSONDecoder().decode(RetainedCleanupRequest.self, from: body)
    #expect(input.reason == "Discard the unpublished experiment")
    let saved = RetainedCleanupModel(podId: f.id, actions: actions)
    #expect(saved.pending == input)
    let files = try FileManager.default.contentsOfDirectory(at: try #require(actions.journalDirectory),
      includingPropertiesForKeys: nil)
    #expect(files.count == 1)
    let attributes = try FileManager.default.attributesOfItem(atPath: try #require(files.first).path)
    #expect(attributes[.posixPermissions] as? Int == 0o600)
    await model.apply(reviewed: reviewed, actions: actions)
    do {
      _ = try await actions.submit(f.id, input)
      Issue.record("Concurrent action must not emit an additional POST")
    } catch { }
    post.respond(status: 401, body: #"{"message":"Fixture auth revoked"}"#)
    await send.value
    f.expectState(.reviewRequired)
    #expect(model.pending == input && !model.canReconcile && model.error?.contains("Outcome unconfirmed") == true)

    let observe = f.start { await saved.refresh(actions) }
    let get = try await f.peer.next()
    #expect(get.request.httpMethod == "GET" && get.request.url?.path == "/pods/\(f.id)/retained-cleanup/\(input.id)")
    get.respond(body: try cleanupReceipt(f.id, input, "partial"))
    await observe.value
    f.expectState(.reviewRequired)
    #expect(saved.receipt?.state == .partial && saved.canReconcile)

    let replay = f.start { await saved.reconcile(actions) }
    let second = try await f.peer.next()
    #expect(second.request.httpMethod == "POST" && second.request.url == post.request.url)
    let replayInput = try JSONDecoder().decode(RetainedCleanupRequest.self, from: cleanupBody(second.request))
    #expect(input == replayInput)
    second.respond(body: try cleanupReceipt(f.id, input, "deleted", wrongResource: true))
    await replay.value
    f.expectState(.reviewRequired)
    #expect(saved.pending == input && saved.receipt?.state == .partial)
    #expect(!saved.canReconcile && saved.error?.contains("Outcome unconfirmed") == true)

    let checkAgain = f.start { await saved.refresh(actions) }
    let last = try await f.peer.next()
    #expect(last.request.url == get.request.url && last.request.httpMethod == "GET")
    last.respond(body: try cleanupReceipt(f.id, input, "deleted"))
    await checkAgain.value
    #expect(saved.receipt?.state == .deleted && f.store.pods.isEmpty)
    #expect(f.peer.requests.count == 5)
  }
}

@MainActor @Test func retainedCleanupTransportDoesNotRemoveMatchingRowOnChangedConnection() async throws {
  try await withConfirmedActionFixture(initial: .failed) { f in
    let actions = f.handler.actions.retainedCleanup
    let plan = try JSONDecoder().decode(RetainedCleanupPlan.self, from: cleanupPlanData())
    let input = RetainedCleanupRequest(id: "original-key", plan: plan, reason: "Discard the unpublished experiment")
    let sent = f.start {
      do {
        _ = try await actions.submit(f.id, input)
        Issue.record("Late reply must not be reported as current")
      } catch { #expect(error.localizedDescription.contains("Connection changed")) }
    }
    let post = try await f.peer.next()
    let row = try #require(f.store.selectedSession)
    f.store.configure(api: DaemonAPI(baseURL: URL(string: "https://replacement.invalid")!, token: "fixture"))
    f.store.upsertSession(row)
    post.respond(body: try cleanupReceipt(f.id, input, "deleted"))
    await sent.value
    #expect(f.store.pods.map(\.id) == [f.id])
    #expect(f.peer.requests.count == 1 && !actions.isCurrent())
  }
}

@MainActor @Test func retainedCleanupTransportDistinguishesOldDaemonAndUnknownExactReceipt() async throws {
  try await withConfirmedActionFixture(initial: .killed) { f in
    let actions = f.handler.actions.retainedCleanup
    let plan = try JSONDecoder().decode(RetainedCleanupPlan.self, from: cleanupPlanData())
    let input = RetainedCleanupRequest(id: "malformed", plan: plan, reason: "Discard the unpublished experiment")
    let malformed = try cleanupReceipt(f.id, input, "deleted")
      .replacingOccurrences(of: try #require(plan.resources.first?.id), with: "friendly-container")
    let task = f.start {
      do { _ = try await actions.inspect(f.id); Issue.record("Expected unsupported") }
      catch RetainedCleanupError.unsupported { } catch { Issue.record("Unexpected error \(error)") }
      do { _ = try await actions.observe(f.id, "exact-key"); Issue.record("Expected exact receipt not found") }
      catch RetainedCleanupError.notFound { } catch { Issue.record("Unexpected error \(error)") }
      do { _ = try await actions.observe(f.id, input.id); Issue.record("A Docker name cannot prove exact absence") }
      catch RetainedCleanupError.invalidReply { } catch { Issue.record("Unexpected error \(error)") }
    }
    let first = try await f.peer.next()
    first.respond(status: 404, body: #"{"message":"Route not found"}"#)
    let second = try await f.peer.next()
    #expect(second.request.url?.path == "/pods/\(f.id)/retained-cleanup/exact-key")
    second.respond(status: 404, body: #"{"code":"POD_NOT_FOUND"}"#)
    let third = try await f.peer.next()
    #expect(third.request.url?.path == "/pods/\(f.id)/retained-cleanup/malformed")
    third.respond(body: malformed)
    await task.value
    f.expectState(.killed)
    #expect(f.peer.requests.count == 3)
  }
}
