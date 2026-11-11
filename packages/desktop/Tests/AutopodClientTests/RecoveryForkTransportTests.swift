import AutopodClient
import AutopodUI
import Foundation
import Testing
@testable import AutopodDesktop

@MainActor @Suite struct RecoveryForkTransportTests {
  @Test func fourBoundRoutesCarryExactDecisionAndOpeningChildDoesNotForkAgain() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let input = forkInput()
      let request = RecoveryForkRequest(id: "exact-request", expectedBinding: String(repeating: "d", count: 64), input: input)
      let inspection = f.startResult { do { _ = try await handler.actions.recoveryFork.inspect("pod"); return "inspected" } catch { return error.localizedDescription } }
      let get = try await f.a.next(); #expect(get.request.httpMethod == "GET" && get.request.url?.path == "/pods/pod/recovery-fork")
      get.respond(body: try forkJSON(kind: "inspection", request: request)); #expect(await inspection.value == "inspected")
      let preview = f.startResult { do { _ = try await handler.actions.recoveryFork.preview("pod", input); return "reviewed" } catch { return error.localizedDescription } }
      let review = try await f.a.next(); #expect(review.request.httpMethod == "POST" && review.request.url?.path == "/pods/pod/recovery-fork/preview")
      #expect(try JSONDecoder().decode(RecoveryForkInput.self, from: forkBody(review.request)) == input)
      review.respond(body: try forkJSON(kind: "preview", request: request)); #expect(await preview.value == "reviewed")
      let creation = f.startResult { do { _ = try await handler.actions.recoveryFork.create("pod", request); return "created" } catch { return error.localizedDescription } }
      let post = try await f.a.next(); #expect(post.request.httpMethod == "POST" && post.request.url?.path == "/pods/pod/recovery-fork")
      let bytes = try forkBody(post.request)
      #expect(try JSONDecoder().decode(RecoveryForkRequest.self, from: bytes) == request)
      let object = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
      #expect(object["actorId"] == nil && object["linkedPodId"] == nil && object["tokenBudget"] == nil && object["autoApprove"] == nil)
      post.respond(body: try forkJSON(kind: "operation", request: request)); #expect(await creation.value == "created")
      let observation = f.startResult { do { _ = try await handler.actions.recoveryFork.observe("pod", request.id); return "observed" } catch { return error.localizedDescription } }
      let getOperation = try await f.a.next(); #expect(getOperation.request.httpMethod == "GET" && getOperation.request.url?.path == "/pods/pod/recovery-fork/exact-request")
      getOperation.respond(body: try forkJSON(kind: "operation", request: request)); #expect(await observation.value == "observed")
      let open = f.startResult { do { try await handler.actions.recoveryFork.openPod("new-child"); return "opened" } catch { return error.localizedDescription } }
      let child = try await f.a.next(); #expect(child.request.httpMethod == "GET" && child.request.url?.path == "/pods/new-child")
      child.respond(body: lifetimePod(id: "new-child")); #expect(await open.value == "opened")
      #expect(f.store.selectedSessionId == "new-child" && f.a.requests.count == 5 && f.b.requests.isEmpty)
    }
  }
  @Test(arguments: ["inspection", "preview", "create", "observe", "open"])
  func changedConnectionCannotSupplyOldRecoveryOrNavigate(operation: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let request = RecoveryForkRequest(id: "exact-request", expectedBinding: String(repeating: "d", count: 64), input: forkInput())
      let work = f.startResult {
        do {
          switch operation {
          case "inspection": _ = try await handler.actions.recoveryFork.inspect("pod")
          case "preview": _ = try await handler.actions.recoveryFork.preview("pod", request.input)
          case "create": _ = try await handler.actions.recoveryFork.create("pod", request)
          case "observe": _ = try await handler.actions.recoveryFork.observe("pod", request.id)
          default: try await handler.actions.recoveryFork.openPod("new-child")
          }
          return "unexpected success"
        } catch { return error.localizedDescription }
      }
      let held = try await f.a.next(); f.store.configure(api: f.apiB); f.seed("pod", task: "new source")
      let kind = operation == "create" || operation == "observe" ? "operation" : operation
      held.respond(body: operation == "open" ? lifetimePod(id: "new-child") : try forkJSON(kind: kind, request: request))
      #expect(await work.value?.contains("Connection changed") == true)
      #expect(f.b.requests.isEmpty && f.store.selectedSessionId == nil && f.store.pods.first?.task == "new source")
    }
  }
  @Test(arguments: [400, 404, 409], ["matching", "wrong-request", "generic"])
  func onlyExplicitCorrelatedPreClaimProofIsAReconsiderableRejection(status: Int, mode: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let request = RecoveryForkRequest(id: "exact-request", expectedBinding: String(repeating: "d", count: 64), input: forkInput())
      let work = f.startResult {
        do { _ = try await f.apiA.createRecoveryFork("pod", body: request); return "unexpected success" }
        catch let error as RecoveryForkRejection { return error.matches(podId: "pod", request: request) ? "verified rejection" : "invalid proof" }
        catch { return "uncertain" }
      }
      let post = try await f.a.next()
      let proof = RecoveryForkRejection(podId: "pod", request: request, message: "Changed before claim.")
      var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(proof)) as? [String: Any])
      if mode == "wrong-request" { object["requestId"] = "different" }
      if mode == "generic" { object["code"] = "GENERIC_ERROR" }
      post.respond(status: status, body: String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self))
      #expect(await work.value == (mode == "matching" && status != 404 ? "verified rejection" : "uncertain"))
    }
  }
  @Test func malformedDecisionIsRefusedBeforeTransportAndMismatchedReceiptIsNotSuccess() async throws {
    try await withPodStoreLifetimeFixture { f in
      let bad = RecoveryForkInput(expectedGeneration: 3, sourceHead: "main", executionProfileId: "@original", instructions: "Continue the task safely.", files: [], acknowledgePartialSource: true)
      do { _ = try await f.apiA.previewRecoveryFork("pod", input: bad); Issue.record("Unbound source was accepted") } catch {}
      do { _ = try await f.apiA.getRecoveryFork("pod", requestId: "path/../injection"); Issue.record("Unbound request path was accepted") } catch {}
      #expect(f.a.requests.isEmpty)
      let request = RecoveryForkRequest(id: "exact-request", expectedBinding: String(repeating: "d", count: 64), input: forkInput())
      let work = f.startResult { do { _ = try await f.apiA.createRecoveryFork("pod", body: request); return "unexpected success" } catch { return "rejected receipt" } }
      let post = try await f.a.next()
      let wrong = try forkJSON(kind: "operation", request: request).replacingOccurrences(of: "\"parentPodId\":\"pod\"", with: "\"parentPodId\":\"other\"")
      post.respond(body: wrong)
      #expect(await work.value == "rejected receipt")
    }
  }
}
private func forkInput() -> RecoveryForkInput {
  RecoveryForkInput(expectedGeneration: 3, sourceHead: String(repeating: "a", count: 40), executionProfileId: "@original", instructions: "Fix the recorded failure without repeating completed work.", files: [], acknowledgePartialSource: true)
}
private func forkJSON(kind: String, request: RecoveryForkRequest) throws -> String {
  let encoder = JSONEncoder()
  let context: [String: Any] = ["summary": "Original task.", "failure": "Build failed.", "messages": [], "truncated": false, "omissions": []]
  let budget: [String: Any] = ["taskId": "original-task", "status": "below_recorded_limit", "tokenBudget": 10000, "recordedTokens": 2000, "retryAuthorizationRequired": false]
  let source: [String: Any] = ["head": request.sourceHead, "tree": String(repeating: "b", count: 40), "baseCommitSha": String(repeating: "c", count: 40), "branch": "autopod/original", "repository": "https://example.com/repo.git", "files": [], "truncated": false, "skippedEntries": 0, "caveats": []]
  var object: [String: Any] = ["version": 1, "podId": "pod", "generation": 3, "available": true, "blockers": [], "source": source, "context": context, "budget": budget]
  if kind == "inspection" { object["profiles"] = [["id": "@original", "label": "Original frozen environment"]]; object["operation"] = NSNull(); object["lineage"] = NSNull() }
  else if kind == "preview" {
    object["expectedBinding"] = request.expectedBinding; object["input"] = try JSONSerialization.jsonObject(with: encoder.encode(request.input))
    object["execution"] = ["profileId": "@original", "target": "local", "template": "node-22", "platform": "linux/amd64", "memoryGb": 4, "cpus": 2, "originalTemplate": "node-22", "sameEnvironment": true]
  } else {
    object = ["version": 1, "id": request.id, "parentPodId": "pod", "generation": 3, "actorId": "human", "request": try JSONSerialization.jsonObject(with: encoder.encode(request)), "state": "queued", "childPodId": "new-child", "childStatus": "queued", "sourceHead": request.sourceHead, "copiedFiles": [], "context": context, "error": NSNull(), "createdAt": "2026-11-10T10:00:00Z"]
  }
  return String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
}
private func forkBody(_ request: URLRequest) throws -> Data {
  if let data = request.httpBody { return data }
  guard let stream = request.httpBodyStream else { throw URLError(.badServerResponse) }
  stream.open(); defer { stream.close() }
  var result = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
  while true { let count = stream.read(&buffer, maxLength: buffer.count); if count == 0 { break }; guard count > 0 else { throw URLError(.badServerResponse) }; result.append(buffer, count: count); guard result.count <= 131_072 else { throw URLError(.badServerResponse) } }
  return result
}
