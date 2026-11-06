import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

private func repairUIFixture(_ key: String, patch: ([String: Any]) -> [String: Any] = { $0 }) throws -> Data {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/repair-continuation-v1.json")
  let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  return try JSONSerialization.data(withJSONObject: patch(all[key] as! [String: Any]))
}
private func repairUIOperation(_ request: RepairContinuationRequestV1, changed: Bool = false) throws -> RepairContinuationOperationV1 {
  var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
  if changed { body["reason"] = "Different same-key authorization reason" }
  return try JSONDecoder().decode(RepairContinuationOperationV1.self, from: repairUIFixture("operation") {
    var value = $0; value["request"] = body; return value
  })
}

@MainActor private final class RepairUIFixture {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let scope = UUID().uuidString
  var loads = 0
  var previews = 0
  var posts = 0
  var observations = 0
  var current = true
  var loadFailure = false
  var unsupported = false
  var changedObservation = false
  var hold = false
  var postOutcome = "accepted"
  var release: CheckedContinuation<Void, Never>?
  var request: RepairContinuationRequestV1?
  var actions: RepairContinuationActions {
    RepairContinuationActions(scope: scope, draftScope: "daemon", journalDirectory: directory, isCurrent: { self.current },
      load: { _ in
        self.loads += 1
        if self.loadFailure { throw DaemonError.notFound("Unsupported repair-continuation-v1") }
        return try JSONDecoder().decode(RepairContinuationInspectionV1.self, from: repairUIFixture("inspection"))
      }, preview: { _, _, _ in
        self.previews += 1
        return try JSONDecoder().decode(RepairContinuationPreviewV1.self, from: repairUIFixture("preview") {
          guard self.unsupported else { return $0 }
          var value = $0; value["conditionalAttemptEligible"] = false
          value["refusals"] = [["code": "unsupported_needs", "message": "Legacy text cannot be qualified"]]
          return value
        })
      }, submit: { _, request in
        self.posts += 1; self.request = request
        let journal = RepairContinuationJournal<RepairContinuationRequestV1>(scope: "daemon", podId: "pod", directory: self.directory)
        #expect(try journal.load() == request) // Exact protected body exists before POST.
        if self.hold { await withCheckedContinuation { self.release = $0 } }
        if self.postOutcome == "lost" { throw DaemonError.networkError("Response lost") }
        if self.postOutcome == "409" { throw DaemonError.serverError(409, "Same-key conflict") }
        return try repairUIOperation(request, changed: self.postOutcome == "malformed")
      }, observe: { _, id in
        self.observations += 1
        guard let request = self.request else { throw DaemonError.notFound("No receipt observed") }
        #expect(id == request.id)
        return try repairUIOperation(request, changed: self.changedObservation)
      })
  }
  func prepare(_ model: RepairContinuationModel) async {
    await model.refresh(actions)
    model.hostHead = String(repeating: "c", count: 40) // Explicit operator input; actual inspection returns null.
    model.profileId = "reviewed-profile"; model.reason = "Use reviewed software without expanding authority"
    await model.loadPreview(actions)
  }
  func clean() { release?.resume(); release = nil; try? FileManager.default.removeItem(at: directory) }
}

@Suite(.serialized) @MainActor struct RepairContinuationTests {
  @Test func scalarBoundsAndECMAScriptTrimAgreeBeforeAnyJournalSaveOrPOST() async throws {
    struct ReasonCase: Decodable {
      let name: String
      let kind: String
      let path: [String]
      let value: String
      let success: Bool
      let canonicalValue: String?
    }
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/repair-continuation-strings.json")
    let vectors = try JSONDecoder().decode([ReasonCase].self, from: Data(contentsOf: url))
      .filter { $0.kind == "request" && $0.path == ["reason"] }
    for vector in vectors {
      let f = RepairUIFixture(); defer { f.clean() }
      let model = RepairContinuationModel(podId: "pod", actions: f.actions)
      await f.prepare(model)
      model.reason = vector.value
      #expect(model.canAuthorize == vector.success, "\(vector.name)")
      await model.authorize(f.actions)
      let journal = RepairContinuationJournal<RepairContinuationRequestV1>(scope: "daemon", podId: "pod", directory: f.directory)
      if vector.success {
        let saved = try #require(try journal.load())
        #expect(saved.reason.utf8.elementsEqual(vector.canonicalValue!.utf8), "\(vector.name)")
        try saved.validate()
        #expect(f.posts == 1 && model.pending == saved && model.operation?.request == saved)
        await model.authorize(f.actions)
        #expect(f.posts == 1) // No replay or replacement of immutable intent.
      } else {
        #expect(f.posts == 0 && model.pending == nil && model.operation == nil, "\(vector.name)")
        #expect(!FileManager.default.fileExists(atPath: journal.url.path))
        #expect(try journal.load() == nil)
        let reopened = RepairContinuationModel(podId: "pod", actions: f.actions)
        await f.prepare(reopened)
        #expect(reopened.pending == nil && reopened.canAuthorize && f.posts == 0)
        // A bad draft never poisons the journal; correction needs no clearing.
        model.reason = "Corrected valid reason"
        #expect(model.canAuthorize)
        await model.authorize(f.actions)
        #expect(f.posts == 1 && model.pending?.reason == "Corrected valid reason")
      }
    }
  }

  @Test(arguments: ["restartedSealed", "restartedValidated", "restartedFailedChecks", "restartedUnsettled"])
  func reopensDurableRestartReceiptsWithoutAuthorization(stage: String) async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let url = ProcessInfo.processInfo.environment["REPAIR_CLIENT_PRODUCER_FIXTURE"].map { URL(fileURLWithPath: $0) }
      ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/repair-continuation-backend.json")
    let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let receipt = try JSONDecoder().decode(RepairContinuationOperationV1.self, from: JSONSerialization.data(withJSONObject: all[stage]!))
    let inspection = try JSONDecoder().decode(RepairContinuationInspectionV1.self, from: JSONSerialization.data(withJSONObject: all[stage + "Inspection"]!))
    let actions = RepairContinuationActions(scope: f.scope, draftScope: "restart", journalDirectory: f.directory,
      load: { _ in f.loads += 1; return inspection },
      preview: { _, _, _ in f.previews += 1; throw URLError(.unsupportedURL) },
      submit: { _, _ in f.posts += 1; throw URLError(.unsupportedURL) },
      observe: { pod, id in
        #expect(pod == receipt.podId && id == receipt.request.id)
        f.observations += 1; return receipt
      })
    for _ in 0..<2 {
      let model = RepairContinuationModel(podId: receipt.podId, actions: actions)
      await model.refresh(actions)
      #expect(model.error == nil && model.operation == receipt && model.pending == receipt.request)
      #expect(!model.canAuthorize && !model.canPreview)
      await model.observe(actions)
      #expect(model.operation == receipt && model.pending == receipt.request)
    }
    let journal = RepairContinuationJournal<RepairContinuationRequestV1>(scope: "restart", podId: receipt.podId, directory: f.directory)
    #expect(try journal.load() == receipt.request)
    #expect(f.posts == 0 && f.previews == 0 && f.observations == 4 && f.loads == 2)
  }

  @Test func productionNullHeadInspectionBindsUserSourceCheckedPreviewForOneConditionalPost() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let url = ProcessInfo.processInfo.environment["REPAIR_CLIENT_PRODUCER_FIXTURE"].map { URL(fileURLWithPath: $0) }
      ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/repair-continuation-backend.json")
    let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let inspection = try JSONDecoder().decode(RepairContinuationInspectionV1.self, from: JSONSerialization.data(withJSONObject: all["inspection"]!))
    let preview = try JSONDecoder().decode(RepairContinuationPreviewV1.self, from: JSONSerialization.data(withJSONObject: all["preview"]!))
    let selected = try #require(preview.selection)
    let actions = RepairContinuationActions(scope: f.scope, draftScope: "producer-gate", journalDirectory: f.directory,
      load: { _ in f.loads += 1; return inspection },
      preview: { pod, head, profile in
        #expect(pod == inspection.podId && head == selected.sourceHead && profile == selected.executionProfileId)
        f.previews += 1; return preview
      }, submit: { _, request in
        f.posts += 1; f.request = request
        #expect(request.sourceHead == selected.sourceHead && request.expectedReportSetHash == selected.expectedReportSetHash)
        throw DaemonError.networkError("Unconfirmed conditional request; no qualified evidence fabricated")
      }, observe: { _, _ in Issue.record("No automatic observe/POST replay"); throw URLError(.unsupportedURL) })
    let model = RepairContinuationModel(podId: inspection.podId, actions: actions)
    await model.refresh(actions)
    #expect(model.snapshot?.available == true && model.snapshot?.sourceHead == nil && !model.canPreview)
    model.hostHead = selected.sourceHead; model.profileId = selected.executionProfileId
    model.reason = "Authorize one bounded conditional repair against the exact preview"
    await model.loadPreview(actions)
    #expect(model.canAuthorize && model.preview?.actualQualification == "not_run" && model.operation == nil)
    await model.authorize(actions); await model.authorize(actions)
    #expect(f.loads == 1 && f.previews == 1 && f.posts == 1)
    #expect(model.pending == f.request && !model.canAuthorize && model.operation == nil)
  }

  @Test(arguments: ["head", "generation", "result", "reports", "requirements"])
  func nullHeadCorrectionDoesNotRelaxOtherSnapshotOrUserSelectionFences(field: String) async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let preview = try JSONDecoder().decode(RepairContinuationPreviewV1.self, from: repairUIFixture("preview"))
    let inspection = try JSONDecoder().decode(RepairContinuationInspectionV1.self, from: repairUIFixture("inspection") {
      var value = $0
      switch field {
      case "head": value["sourceHead"] = String(repeating: "1", count: 40)
      case "generation": value["generation"] = 3
      case "result": value["expectedResultHash"] = String(repeating: "1", count: 64)
      case "reports": value["expectedReportSetHash"] = String(repeating: "1", count: 64)
      default: value["requirementsHash"] = String(repeating: "1", count: 64)
      }
      return value
    })
    let actions = RepairContinuationActions(scope: f.scope, draftScope: "stale", journalDirectory: f.directory,
      load: { _ in inspection }, preview: { _, _, _ in preview },
      submit: { _, request in f.posts += 1; return try repairUIOperation(request) },
      observe: { _, _ in throw URLError(.unsupportedURL) })
    let model = RepairContinuationModel(podId: "pod", actions: actions)
    await model.refresh(actions)
    model.hostHead = preview.selection!.sourceHead; model.profileId = preview.selection!.executionProfileId
    model.reason = "Review exact conditional source before authorization"
    await model.loadPreview(actions); await model.authorize(actions)
    #expect(!model.canAuthorize && f.posts == 0 && model.pending == nil)
  }

  @Test func supportedConditionalAttemptCanAuthorizeBeforeQualificationButCannotSkipProbes() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model)
    #expect(model.snapshot?.available == true && model.snapshot?.sourceHead == nil)
    #expect(model.canAuthorize && model.preview?.actualQualification == "not_run")
    #expect(model.operation == nil && f.posts == 0 && f.loads == 1 && f.previews == 1)
    await model.authorize(f.actions)
    #expect(f.posts == 1 && model.pending == f.request)
    #expect(model.operation?.state == .claimed && model.operation?.qualification == nil && model.operation?.codingAdmission == .notAdmitted)
    #expect(!model.canAuthorize)
    await model.observe(f.actions)
    #expect(f.observations == 1 && f.posts == 1 && model.operation?.checks == .notStarted)
  }

  @Test(arguments: ["lost", "409", "malformed"])
  func doubleClickAndReopenPreserveExactRequestAndOnlyObserve(outcome: String) async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    f.postOutcome = outcome; f.hold = true
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model)
    let task = Task { await model.authorize(f.actions) }
    for _ in 0..<200 { if f.release != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
    try #require(f.release != nil)
    await model.authorize(f.actions)
    #expect(f.posts == 1 && model.busy)
    f.release?.resume(); f.release = nil
    await task.value
    #expect(model.operation == nil && model.pending != nil && model.error?.contains("unconfirmed") == true)
    let saved = model.pending
    let reopened = RepairContinuationModel(podId: "pod", actions: f.actions)
    await reopened.refresh(f.actions)
    #expect(reopened.pending == saved && reopened.operation?.request == saved)
    #expect(!reopened.canAuthorize && f.posts == 1 && f.observations == 1)
    await reopened.authorize(f.actions)
    #expect(f.posts == 1)
  }

  @Test func twoPreparedSheetsCannotReplaceAnUncertainRequest() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let first = RepairContinuationModel(podId: "pod", actions: f.actions)
    let second = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(first); await f.prepare(second)
    f.hold = true
    let task = Task { await first.authorize(f.actions) }
    for _ in 0..<200 { if f.release != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
    try #require(f.release != nil)
    await second.authorize(f.actions)
    #expect(f.posts == 1 && second.pending == nil && !second.canAuthorize && second.error?.contains("nothing was sent") == true)
    f.release?.resume(); f.release = nil; await task.value
    #expect(first.pending == f.request)
  }

  @Test func sameKeyDifferentObservedBodyNeverReplacesSavedIntent() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    f.postOutcome = "lost"
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model); await model.authorize(f.actions)
    let original = model.pending
    f.changedObservation = true
    await model.observe(f.actions)
    #expect(model.operation == nil && model.pending == original && model.error != nil && f.posts == 1 && f.observations == 1)
  }

  @Test func unsupportedAndOldDaemonNeverEnableAuthorizationOrFallback() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    f.loadFailure = true
    let old = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(old); await old.authorize(f.actions)
    #expect(!old.canPreview && !old.canAuthorize && f.posts == 0 && f.previews == 0 && old.error != nil)
    f.loadFailure = false; f.unsupported = true
    let unsupported = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(unsupported); await unsupported.authorize(f.actions)
    #expect(!unsupported.canAuthorize && unsupported.preview?.refusals.first?.code == "unsupported_needs" && f.posts == 0)
  }

  @Test func changedSelectionAndConnectionInvalidateClientAuthority() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model); #expect(model.canAuthorize)
    model.profileId = "other-profile"; #expect(!model.canAuthorize)
    model.profileId = "reviewed-profile"; #expect(model.canAuthorize)
    f.current = false
    await model.authorize(f.actions)
    #expect(f.posts == 0 && model.preview == nil && model.error?.contains("Connection changed") == true)
  }

  @Test func lateSubmitResultCannotCrossConnectionAndJournalRemainsOwned() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model); f.hold = true
    let task = Task { await model.authorize(f.actions) }
    for _ in 0..<200 { if f.release != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
    try #require(f.release != nil)
    f.current = false; f.release?.resume(); f.release = nil
    await task.value
    #expect(model.operation == nil && model.pending == f.request && model.error?.contains("Connection changed") == true)
    #expect(f.posts == 1)
  }

  @Test func corruptJournalBlocksAllNewAuthorizationWithoutNetwork() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let journal = RepairContinuationJournal<RepairContinuationRequestV1>(scope: "daemon", podId: "pod", directory: f.directory)
    try FileManager.default.createDirectory(at: f.directory, withIntermediateDirectories: true)
    try Data("corrupted saved request".utf8).write(to: journal.url)
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    await f.prepare(model); await model.authorize(f.actions)
    #expect(f.loads == 0 && f.previews == 0 && f.posts == 0 && !model.canAuthorize)
    #expect(model.error?.contains("unreadable") == true)
  }

  @Test func renderedSheetKeepsConditionalPreviewDistinctAndBlocksBusyDoubleClick() async throws {
    let f = RepairUIFixture(); defer { f.clean() }
    let model = RepairContinuationModel(podId: "pod", actions: f.actions)
    let host = LaunchComposerHost(RepairContinuationSheet(podId: "pod", actions: f.actions, model: model), width: 1000)
    defer { host.close() }
    try await host.wait { model.snapshot != nil && !model.busy }
    #expect(!host.enabled("repair-continuation-authorize") && f.posts == 0)
    model.hostHead = String(repeating: "c", count: 40)
    model.profileId = "reviewed-profile"; model.reason = "Use reviewed software without expanding authority"
    await model.loadPreview(f.actions)
    try await host.wait { host.enabled("repair-continuation-authorize") }
    #expect(host.has("repair-continuation-conditional"))
    #expect(model.preview?.actualQualification == "not_run" && model.operation == nil)
    f.hold = true
    let task = Task { await model.authorize(f.actions) }
    for _ in 0..<200 { if f.release != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
    try #require(f.release != nil)
    try await host.wait { !host.has("repair-continuation-authorize") || !host.enabled("repair-continuation-authorize") }
    await model.authorize(f.actions)
    #expect(f.posts == 1)
    f.release?.resume(); f.release = nil; await task.value
    #expect(model.operation?.qualification == nil && model.operation?.codingAdmission == .notAdmitted)
  }
}
