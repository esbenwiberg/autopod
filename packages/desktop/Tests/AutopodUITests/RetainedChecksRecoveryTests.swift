import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@MainActor @Suite struct RetainedChecksRecoveryTests {
  private let podId = "legacy-timeout"

  private func preview(generation: Int = 2, head: String = String(repeating: "a", count: 40)) throws -> RetainedChecksPreview {
    try JSONDecoder().decode(RetainedChecksPreview.self, from: JSONSerialization.data(withJSONObject: [
      "version": 1, "podId": podId, "branch": "feat/checkpoint", "checkpointHead": head,
      "checkpointTree": String(repeating: "b", count: 40), "expectedGeneration": generation,
      "expectedResultHash": String(repeating: "c", count: 64),
    ]))
  }

  private func operation(_ decision: RetainedChecksDecision, passedTree: String) throws -> RetainedChecksOperation {
    let preview = decision.preview
    return try JSONDecoder().decode(RetainedChecksOperation.self, from: JSONSerialization.data(withJSONObject: [
      "id": decision.id, "podId": podId, "generation": preview.expectedGeneration, "reason": decision.reason,
      "binding": [
        "branch": preview.branch, "head": preview.checkpointHead, "resultHash": preview.expectedResultHash,
        "continuation": ["prepareOnly": false, "reviewPolicy": "independent-v1"],
      ],
      "activated": ["generation": preview.expectedGeneration + 1],
      "checking": ["generation": preview.expectedGeneration + 1],
      "checked": ["result": ["overall": "pass"], "source": ["head": preview.checkpointHead, "tree": passedTree]],
    ]))
  }

  @Test func changedPreviewSendsNothing() async throws {
    let first = try preview()
    let second = try preview(generation: 3)
    var loads = 0
    var sends = 0
    let actions = RetainedChecksActions(scope: "connection", draftScope: UUID().uuidString,
      preview: { _ in loads += 1; return loads == 1 ? first : second },
      submit: { _, _ in sends += 1; throw URLError(.networkConnectionLost) },
      observe: { _, _ in throw URLError(.unsupportedURL) })
    let model = RetainedChecksRecoveryModel(podId: podId, actions: actions)
    await model.refresh(actions, inspectSource: true)
    model.reason = "Review the exact saved checkpoint"
    model.confirmed = true
    #expect(model.canSubmit)
    await model.submit(actions)
    #expect(sends == 0)
    #expect(model.pending == nil)
    #expect(!model.canSubmit)
  }

  @Test func lostReplyIsObservedAfterReopenWithoutPostingAgain() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = try preview()
    var sends: [String] = []
    var observations: [String] = []
    let actions = RetainedChecksActions(scope: "connection", draftScope: "known-daemon", journalDirectory: folder,
      preview: { _ in source },
      submit: { _, value in sends.append(value.id); throw URLError(.networkConnectionLost) },
      observe: { _, value in
        observations.append(value.id)
        return try operation(value, passedTree: source.checkpointTree)
      })
    let model = RetainedChecksRecoveryModel(podId: podId, actions: actions)
    await model.refresh(actions, inspectSource: true)
    model.reason = "Review the exact saved checkpoint"
    model.confirmed = true
    await model.submit(actions)
    #expect(model.needsObservation)
    let reopened = RetainedChecksRecoveryModel(podId: podId, actions: actions)
    await reopened.refresh(actions, inspectSource: false)
    #expect(sends.count == 1)
    #expect(sends == observations)
    #expect(!reopened.needsObservation)
    #expect(reopened.outcome.contains("Nothing was published"))
    #expect(!reopened.canSubmit)
  }

  @Test func passingReceiptMustMatchExactSelectedTree() throws {
    let source = try preview()
    let decision = RetainedChecksDecision(id: "stable-id", preview: source, reason: "Review the exact saved checkpoint")
    let receipt = try operation(decision, passedTree: String(repeating: "d", count: 40))
    #expect(throws: DaemonError.self) { try receipt.validate(podId: podId, decision: decision) }
  }

  @Test func refusedPreviewCannotSubmit() async {
    var sends = 0
    let actions = RetainedChecksActions(scope: "connection", draftScope: UUID().uuidString,
      preview: { _ in throw DaemonError.badRequest("Original Docker resource is not confirmed stopped") },
      submit: { _, _ in sends += 1; throw URLError(.unsupportedURL) },
      observe: { _, _ in throw URLError(.unsupportedURL) })
    let model = RetainedChecksRecoveryModel(podId: podId, actions: actions)
    await model.refresh(actions, inspectSource: true)
    model.reason = "Review the exact saved checkpoint"
    model.confirmed = true
    await model.submit(actions)
    #expect(model.error?.contains("not confirmed stopped") == true)
    #expect(sends == 0)
  }
}
