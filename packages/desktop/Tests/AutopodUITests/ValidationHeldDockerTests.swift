import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct ValidationHeldDockerTests {
  private func reply(_ state: String, request: RetainedFinalizationRequest? = nil) throws -> ValidationHeldDockerView {
    var json: [String: Any] = ["podId": "held-fixture", "state": state, "generation": 1,
      "binding": String(repeating: "a", count: 64), "message": "Validation hold retained", "blockers": [],
      "resources": [["kind": "docker_container", "role": "guest_execution", "id": String(repeating: "b", count: 64), "namespace": "fixture-engine"]]]
    if let request { json["requestKey"] = request.requestKey }
    return try JSONDecoder().decode(ValidationHeldDockerView.self, from: JSONSerialization.data(withJSONObject: json))
  }

  @Test func journalBeforeStopThenObserveWithoutReplayAndRejectChangedConnection() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    var sent: [RetainedFinalizationRequest] = []
    var actions = ValidationHeldDockerActions()
    actions.scope = "fixture-scope"; actions.connection = "fixture-daemon"; actions.journalDirectory = directory
    actions.isCurrent = { true }
    actions.inspect = { _, key in
      if let key {
        let request = try #require(sent.first)
        #expect(request.requestKey == key)
        return try self.reply("unknown", request: request)
      }
      return try self.reply("eligible")
    }
    actions.submit = { _, request in
      #expect(!((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).isEmpty)
      sent.append(request)
      throw URLError(.networkConnectionLost)
    }
    let model = ValidationHeldDockerModel(podId: "held-fixture", actions: actions)
    await model.refresh(actions)
    model.reason = "Stop exact owned execution and retain all files"
    #expect(model.canSubmit)
    await model.apply(actions)
    #expect(sent.count == 1 && model.needsObservation)
    let reopened = ValidationHeldDockerModel(podId: "held-fixture", actions: actions)
    await reopened.refresh(actions)
    #expect(sent.count == 1 && reopened.snapshot?.state == "unknown")
    actions.scope = "different-connection"
    await reopened.reconcile(actions)
    #expect(sent.count == 1)
  }

  @Test func unknownStatesAndWrongPodsDoNotProveStopped() throws {
    let value = try reply("unexpected-future-state")
    #expect(throws: RetainedCleanupError.self) { try value.validate(podId: "held-fixture") }
    let eligible = try reply("eligible")
    #expect(throws: RetainedCleanupError.self) { try eligible.validate(podId: "different-pod") }
  }
}
