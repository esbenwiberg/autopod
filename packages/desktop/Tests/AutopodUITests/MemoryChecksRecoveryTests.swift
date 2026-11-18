import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct MemoryChecksRecoveryTests {
  private func inspection(generation: Int = 2, state: String = "requires_candidate", operations: [[String: Any]] = []) throws -> MemoryChecksInspection {
    let source = ["head": String(repeating: "a", count: 40), "tree": String(repeating: "b", count: 40)]
    let json: [String: Any] = ["operations": operations, "inspection": [
      "generation": generation, "selection": ["expectedGeneration": generation, "expectedResultHash": String(repeating: "c", count: 64)],
      "memoryRecovery": ["version": 1, "state": state, "reason": state == "unavailable" ? "Prior effective heap evidence is missing." : "Candidate requires actual heap improvement before dispatch.",
        "source": source, "predecessorId": "prior", "candidateQualification": "not_run",
        "priorMemory": ["heapLimitBytes": 2_147_483_648, "containerLimitBytes": 8_589_934_592]]]]
    return try JSONDecoder().decode(MemoryChecksInspection.self, from: JSONSerialization.data(withJSONObject: json))
  }
  private func preview() throws -> MemoryChecksPreview {
    try JSONDecoder().decode(MemoryChecksPreview.self, from: JSONSerialization.data(withJSONObject: [
      "profileId": "memory", "digest": String(repeating: "d", count: 64), "target": "local"]))
  }

  @Test func eligibleInspectionIsReadOnlyAndConfirmationIsExplicit() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    var posts = 0
    let actions = MemoryChecksActions(scope: "scope", draftScope: "daemon-owner", journalDirectory: folder,
      load: { _ in try inspection() }, preview: { _, _ in try preview() },
      submit: { _, _ in posts += 1; throw URLError(.networkConnectionLost) })
    let model = MemoryChecksRecoveryModel(podId: "concerned-pheasant", actions: actions)
    await model.refresh(actions); model.profileId = "memory"
    #expect(model.canPreview && !model.canConfirm && posts == 0)
    #expect(model.savedWork.contains(String(repeating: "a", count: 40)))
    await model.loadPreview(actions); model.reason = "Retry saved checks within existing permission"
    #expect(!model.canConfirm)
    model.confirmed = true
    #expect(model.canConfirm)
    await model.submit(actions)
    #expect(posts == 1 && model.pending != nil && model.needsObservation)
    #expect(model.outcome.contains("unconfirmed"))
    let pending = try #require(model.pending)
    let reopened = MemoryChecksRecoveryModel(podId: "concerned-pheasant", actions: actions)
    await reopened.refresh(actions)
    #expect(reopened.pending == pending && reopened.needsObservation && !reopened.canConfirm)
    await reopened.submit(actions)
    #expect(posts == 1)
    #expect(reopened.error?.contains("Absence does not authorize replay") == true)
  }

  @Test func unavailableEvidenceExplainsOneHonestNextStep() async throws {
    let actions = MemoryChecksActions(scope: "unavailable-test", draftScope: UUID().uuidString,
      journalDirectory: FileManager.default.temporaryDirectory,
      load: { _ in try inspection(state: "unavailable") }, preview: { _, _ in throw URLError(.unsupportedURL) },
      submit: { _, _ in throw URLError(.unsupportedURL) })
    let model = MemoryChecksRecoveryModel(podId: "concerned-pheasant", actions: actions)
    await model.refresh(actions); model.profileId = "memory"
    #expect(!model.canPreview && !model.canConfirm)
    #expect(model.nextStep.contains("missing"))
  }

  @Test func observesACorrelatedCompletedRequestWithoutSendingAgain() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    var records: [[String: Any]] = []
    var posts = 0
    let actions = MemoryChecksActions(scope: "scope", draftScope: "daemon-owner", journalDirectory: folder,
      load: { _ in try inspection(operations: records) }, preview: { _, _ in try preview() },
      submit: { _, _ in posts += 1; throw URLError(.networkConnectionLost) })
    let model = MemoryChecksRecoveryModel(podId: "concerned-pheasant", actions: actions)
    await model.refresh(actions); model.profileId = "memory"; await model.loadPreview(actions)
    model.reason = "Retry saved checks within existing permission"; model.confirmed = true
    await model.submit(actions)
    let saved = try #require(model.pending)
    records = [["id": saved.id, "podId": "concerned-pheasant", "generation": 2, "reason": saved.reason,
      "binding": ["head": saved.checkpointHead, "resultHash": saved.expectedResultHash,
        "continuation": ["execution": ["profileId": saved.executionProfileId, "digest": saved.expectedExecutionDigest],
          "infrastructure": ["mode": "checks", "qualification": saved.qualification, "predecessorChecksId": "prior"]]],
      "activated": ["generation": 3], "checking": ["generation": 3],
      "checked": ["result": ["overall": "pass"], "source": ["head": saved.checkpointHead, "tree": String(repeating: "b", count: 40)]]]]
    await model.refresh(actions)
    #expect(posts == 1 && model.hasSavedRequest && !model.needsObservation)
    #expect(model.outcome.contains("Fresh checks passed") && !model.canConfirm)
  }

  @Test func staleGenerationOrConnectionPreventsSavingOrSending() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    var generation = 2
    var current = true
    var posts = 0
    let actions = MemoryChecksActions(scope: "scope", draftScope: "daemon-owner", journalDirectory: folder,
      isCurrent: { current }, load: { _ in try inspection(generation: generation) }, preview: { _, _ in try preview() },
      submit: { _, _ in posts += 1; throw URLError(.networkConnectionLost) })
    let model = MemoryChecksRecoveryModel(podId: "concerned-pheasant", actions: actions)
    await model.refresh(actions); model.profileId = "memory"; await model.loadPreview(actions)
    model.reason = "Explicit checks-only decision"; model.confirmed = true
    generation = 3
    await model.submit(actions)
    #expect(posts == 0 && model.pending == nil && model.stale && !model.canConfirm)
    await model.refresh(actions); await model.loadPreview(actions); model.confirmed = true
    current = false
    await model.submit(actions)
    #expect(posts == 0 && model.pending == nil && model.stale)
  }
}
