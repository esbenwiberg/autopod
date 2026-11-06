import AutopodClient
import AutopodDesktop
import Foundation
import Testing

private func repairFixture(_ key: String) throws -> String {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/repair-continuation-v1.json")
  let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  return String(decoding: try JSONSerialization.data(withJSONObject: all[key]!), as: UTF8.self)
}
private func repairInput() throws -> RepairContinuationRequestV1 {
  try JSONDecoder().decode(RepairContinuationRequestV1.self, from: Data(repairFixture("request").utf8))
}
private func bodyData(_ request: URLRequest) throws -> Data {
  if let data = request.httpBody { return data }
  guard let stream = request.httpBodyStream else { throw URLError(.badServerResponse) }
  stream.open(); defer { stream.close() }
  var data = Data(); var buffer = [UInt8](repeating: 0, count: 2048)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count < 0 { throw stream.streamError ?? URLError(.badServerResponse) }
    if count == 0 { break }; data.append(contentsOf: buffer.prefix(count))
  }
  return data
}

@MainActor @Suite struct RepairContinuationTransportTests {
  @Test func inspectionPreviewObserveNeverPostAndConditionalEligibilityIsNotProof() async throws {
    try await withPodStoreLifetimeFixture { f in
      let inspect = f.startResult {
        do { let value = try await f.apiA.inspectRepairContinuation("pod"); #expect(value.operation == nil); return "ok" }
        catch { return error.localizedDescription }
      }
      try await f.next(f.a, "/pods/pod/repair-continuation-v1").respond(body: repairFixture("inspection"))
      #expect(await inspect.value == "ok")
      let input = try repairInput()
      let preview = f.startResult {
        do {
          let value = try await f.apiA.previewRepairContinuation("pod", sourceHead: input.sourceHead, profileId: input.executionProfileId)
          #expect(value.conditionalAttemptEligible && value.actualQualification == "not_run" && value.configurationOnly)
          return "ok"
        } catch { return error.localizedDescription }
      }
      let query = try await f.next(f.a, "/pods/pod/repair-continuation-v1/preview")
      let fields = URLComponents(url: query.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
      #expect(fields.contains(URLQueryItem(name: "sourceHead", value: input.sourceHead)))
      #expect(fields.contains(URLQueryItem(name: "executionProfileId", value: input.executionProfileId)))
      query.respond(body: try repairFixture("preview"))
      #expect(await preview.value == "ok")
      let observe = f.startResult {
        do { let value = try await f.apiA.observeRepairContinuation("pod", requestId: input.id); #expect(value.codingAdmission == .notAdmitted && value.qualification == nil); return "ok" }
        catch { return error.localizedDescription }
      }
      try await f.next(f.a, "/pods/pod/repair-continuation-v1/requests/stable-request").respond(body: repairFixture("operation"))
      #expect(await observe.value == "ok")
      #expect(f.a.requests.count == 3 && f.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  @Test func exactAuthorizationBodyAndSeparateFinalSourceDecodeWithoutPublication() async throws {
    try await withPodStoreLifetimeFixture { f in
      let input = try repairInput()
      let task = f.startResult {
        do {
          let result = try await f.apiA.authorizeRepairContinuation("pod", input: input)
          #expect(result.state == .claimed && result.qualification == nil && result.codingAdmission == .notAdmitted)
          return "ok"
        } catch { return error.localizedDescription }
      }
      let post = try await f.a.next()
      #expect(post.request.url?.path == "/pods/pod/repair-continuation-v1" && post.request.httpMethod == "POST")
      #expect(post.request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
      let body = try bodyData(post.request)
      #expect(try JSONDecoder().decode(RepairContinuationRequestV1.self, from: body) == input)
      #expect(Set((try JSONSerialization.jsonObject(with: body) as! [String: Any]).keys) == ["version", "intent", "id", "expectedGeneration", "expectedResultHash", "expectedReportSetHash", "sourceHead", "executionProfileId", "expectedExecutionDigest", "expectedBindingDigest", "reason"])
      post.respond(status: 202, body: try repairFixture("operation"))
      #expect(await task.value == "ok")
      let final = try JSONDecoder().decode(RepairContinuationOperationV1.self, from: Data(repairFixture("validatedOperation").utf8))
      try final.validate(podId: "pod", requestId: input.id, expected: input)
      #expect(final.state == .validated && final.checks == .passed && final.codingAdmission == .consumed)
      #expect(final.codingFinalSource?.source.head != input.sourceHead && final.requiresHumanApproval && !final.publicationAuthorized)
      #expect(f.a.requests.count == 1)
    }
  }

  @Test(arguments: ["401", "404", "409", "malformed202", "lost", "wrong-request", "unproven-coding", "old-version"])
  func failuresNeverFallbackOrRepeatAuthorization(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let input = try repairInput()
      let task = f.startResult {
        do { _ = try await f.apiA.authorizeRepairContinuation("pod", input: input); return "unexpected success" }
        catch { return error.localizedDescription }
      }
      let post = try await f.a.next()
      if let status = Int(kind) { post.respond(status: status, body: #"{"error":"Refused or unsupported"}"#) }
      else if kind == "lost" { post.fail(URLError(.timedOut)) }
      else {
        var value = try JSONSerialization.jsonObject(with: Data(repairFixture("operation").utf8)) as! [String: Any]
        if kind == "wrong-request" { var request = value["request"] as! [String: Any]; request["reason"] = "Different saved authorization reason"; value["request"] = request }
        if kind == "unproven-coding" { value["codingAdmission"] = "consumed" }
        if kind == "old-version" { value["version"] = 99 }
        let body = kind == "malformed202" ? "{}" : String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        post.respond(status: 202, body: body)
      }
      #expect(await task.value != "unexpected success")
      #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
      #expect(f.a.requests.allSatisfy { $0.url?.path == "/pods/pod/repair-continuation-v1" })
    }
  }

  @Test(arguments: ["unknown-static", "qualified-preview", "wrong-source", "missing-diff", "sandbox-replacement", "native-platform"])
  func malformedOrUnsupportedStaticPreviewCannotEnableAuthorization(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let input = try repairInput()
      var value = try JSONSerialization.jsonObject(with: Data(repairFixture("preview").utf8)) as! [String: Any]
      if kind == "unknown-static" { value.removeValue(forKey: "conditionalAttemptEligible") }
      if kind == "qualified-preview" { value["actualQualification"] = "qualified" }
      if kind == "wrong-source" { var selection = value["selection"] as! [String: Any]; selection["sourceHead"] = String(repeating: "1", count: 40); value["selection"] = selection }
      if kind == "missing-diff" { value["configurationDiff"] = NSNull() }
      if kind == "sandbox-replacement" || kind == "native-platform" {
        var diff = value["configurationDiff"] as! [String: Any]; var after = diff["after"] as! [String: Any]
        after[kind == "sandbox-replacement" ? "target" : "platform"] = kind == "sandbox-replacement" ? "sandbox" : "darwin/arm64"
        diff["after"] = after; value["configurationDiff"] = diff
      }
      let body = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
      let task = f.startResult {
        do { _ = try await f.apiA.previewRepairContinuation("pod", sourceHead: input.sourceHead, profileId: input.executionProfileId); return "unexpected success" }
        catch { return error.localizedDescription }
      }
      try await f.next(f.a, "/pods/pod/repair-continuation-v1/preview").respond(body: body)
      #expect(await task.value != "unexpected success")
      #expect(f.a.requests.count == 1 && f.a.requests[0].httpMethod == "GET")
    }
  }

  @Test(arguments: ["inspect", "preview", "submit", "observe"], [200, 404, 503])
  func lateResponsesAndErrorsCannotCrossDaemonOwnership(mode: String, status: Int) async throws {
    try await withPodStoreLifetimeFixture { f in
      let input = try repairInput()
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let actions = handler.actions.repairContinuation
      let task = f.startResult {
        do {
          switch mode {
          case "inspect": _ = try await actions.load("pod")
          case "preview": _ = try await actions.preview("pod", input.sourceHead, input.executionProfileId)
          case "submit": _ = try await actions.submit("pod", input)
          default: _ = try await actions.observe("pod", input.id)
          }
          return "unexpected success"
        } catch { return error.localizedDescription }
      }
      let call = try await f.a.next()
      f.store.configure(api: f.apiB); f.seed("pod", task: "new owner")
      let key = mode == "inspect" ? "inspection" : mode == "preview" ? "preview" : "operation"
      call.respond(status: status, body: status == 200 ? try repairFixture(key) : #"{"error":"Old owner error"}"#)
      #expect(await task.value?.contains("Connection changed") == true)
      #expect(f.store.pods.first?.task == "new owner" && f.b.requests.isEmpty && f.a.requests.count == 1)
      // Obsolete closures cannot send anything, even after the old request returned.
      do { _ = try await actions.submit("pod", input); Issue.record("Obsolete submit accepted") } catch {}
      #expect(f.a.requests.count == 1)
    }
  }
}
