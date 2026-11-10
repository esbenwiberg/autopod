import AutopodClient
import CryptoKit
import AutopodUI
import Foundation
import Observation

/// In-memory interaction fixtures only. No DaemonAPI, provider, credentials or task execution.
@MainActor @Observable public final class DesktopRecoveryFixtures {
  public enum Scenario: String, CaseIterable, Identifiable {
    case retained = "Retained environment"
    case unknownStart = "Unknown start outcome"
    case held = "Cleanup blocked by custody"
    public var id: String { rawValue }
  }

  public let podId = "cleanup-demo"
  public var scenario = Scenario.retained {
    didSet {
      guard scenario != oldValue else { return }
      generation += 1; providerState = "stopped"; requests = [:]; receipts = [:]
    }
  }
  public private(set) var generation = 1
  public private(set) var mutationCount = 0
  public let journalDirectory: URL
  private let session = UUID().uuidString
  private var providerState = "stopped"
  private var requests: [String: SandboxRecoveryRequest] = [:]
  private var receipts: [String: SandboxRecoveryReceipt] = [:]
  private let date = "2026-11-10T10:00:00Z"
  private let sandboxId = "preview-retained-environment"
  private let userId = "preview-human"

  public init(journalDirectory: URL? = nil) {
    self.journalDirectory = journalDirectory ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-recovery-preview-\(UUID().uuidString)", isDirectory: true)
  }

  private func key(_ epoch: Int) -> String { "fixture-only://recovery/\(epoch)/\(podId)" }
  private func requireCurrent(_ epoch: Int) throws {
    guard epoch == generation else { throw DaemonError.badRequest("Sample scenario changed. Reopen recovery; no live action was performed.") }
  }
  private func unavailable() -> DaemonError {
    .badRequest("This sample-data preview cannot run coding, checks, publication or real recovery.")
  }
  private func decode<T: Decodable>(_ object: [String: Any], as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
  }
  private func wire<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
  }

  private func receipt(_ request: SandboxRecoveryRequest, completed: Bool) throws -> SandboxRecoveryReceipt {
    try decode(["id": request.id, "podId": podId, "sandboxId": request.sandboxId,
      "resourceKey": request.expectedResourceKey, "generation": request.expectedGeneration,
      "action": request.action, "userId": userId, "reason": request.reason,
      "createdAt": date, "completedAt": completed ? date : NSNull()])
  }

  private func inspect(_ id: String, epoch: Int) throws -> SandboxRecoveryState {
    try requireCurrent(epoch)
    guard id == podId else {
      return try decode(["podId": id, "generation": epoch, "currentUserId": userId,
        "resources": [], "operations": [], "wakeups": []])
    }
    var operations = try receipts.values.sorted { $0.id < $1.id }.map { try wire($0) }
    if scenario == .unknownStart {
      let request = SandboxRecoveryRequest(id: "fixture-lost-start-\(epoch)", action: "start", sandboxId: sandboxId,
        expectedGeneration: epoch, expectedResourceKey: key(epoch), reason: "Simulated start response was lost")
      operations.insert(try wire(receipt(request, completed: false)), at: 0)
    }
    let unknown = scenario == .unknownStart && providerState != "deleted"
    let startBlocked: String? = scenario == .held ? "Sample source custody blocks machine start. No real environment is being inspected."
      : unknown ? "Sample start outcome is unknown. Another start is not permitted."
      : providerState == "deleted" ? "The sample environment was deleted; no real resource was affected." : nil
    let abandonment = receipts.values.first { $0.action == "abandon" }
    let resource: [String: Any] = ["sandboxId": sandboxId, "resourceKey": key(epoch), "providerState": providerState,
      "observedAt": date, "pendingIntentIds": unknown ? ["fixture-wakeup-\(epoch)"] : [],
      "observationError": NSNull(), "startBlocked": startBlocked.map { $0 as Any } ?? NSNull(),
      "abandonBlocked": scenario == .held ? "Sample retained source owns this environment. Discard is blocked; no override is provided." : NSNull(),
      "abandonment": try abandonment.map { try wire($0) } ?? NSNull()]
    return try decode(["podId": podId, "generation": epoch, "currentUserId": userId,
      "resources": [resource], "operations": operations, "wakeups": []])
  }

  private func submit(_ id: String, _ request: SandboxRecoveryRequest, epoch: Int) throws -> SandboxRecoveryResult {
    try requireCurrent(epoch)
    guard id == podId, request.expectedGeneration == epoch, request.sandboxId == sandboxId,
      request.expectedResourceKey == key(epoch), scenario != .held,
      (10...4000).contains(request.reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
      ["start", "abandon"].contains(request.action), request.action != "abandon" || request.acknowledgeDataLoss else {
      throw unavailable()
    }
    if let saved = requests[request.id] {
      guard saved == request else { throw DaemonError.badRequest("The saved sample request cannot be replaced.") }
    } else {
      if request.action == "start" {
        guard providerState == "stopped", scenario != .unknownStart else { throw unavailable() }
        providerState = "running"
      } else { providerState = "deleted" }
      requests[request.id] = request
      receipts[request.id] = try receipt(request, completed: true)
      mutationCount += 1
    }
    guard let receipt = receipts[request.id] else { throw unavailable() }
    return try decode(["operation": try wire(receipt), "podDeleted": false,
      "cleanupError": request.action == "abandon"
        ? "Sample task history remains visible. No real pod, files or cloud resource was deleted." : NSNull()])
  }

  private func fileData(_ source: String) -> [String: Data] {
    if source == "saved-workspace" {
      return ["RECOVERY.md": Data("# Sample saved copy\nThis is example data, not an actual task checkpoint. Other files may remain in the original environment.\n".utf8),
        "reports/test-results.txt": Data("Sample report: validation did not pass. No actual checks were run by this preview.\n".utf8)]
    }
    return ["src/container-cleanup.ts": Data("// Sample original file, not actual task code.\nexport const sample = 'retained environment';\n".utf8),
      "notes.bin": Data([0, 255, 128, 10, 3]),
      "unsaved-notes.txt": Data("Sample notes present only in the original fixture. Saving a copy does not release custody or delete anything.\n".utf8)]
  }
  private func fileHash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
  private func fileBinding(_ id: String, epoch: Int) -> String { fileHash(Data("\(session):\(epoch):\(id)".utf8)) }
  private func inspectFiles(_ id: String, epoch: Int, includeOriginal: Bool = false) throws -> RecoveryFilesSnapshot {
    try requireCurrent(epoch)
    var sources: [[String: Any]] = []
    if id == podId {
      for source in ["saved-workspace", "original"] {
        let saved = source == "saved-workspace"
        let available = saved || (scenario == .retained && providerState == "running")
        let status = available ? (saved || includeOriginal ? "available" : "ready") : scenario == .retained && providerState == "stopped" ? "stopped" : "blocked"
        let files: [[String: Any]] = available && (saved || includeOriginal) ? fileData(source).sorted { $0.key < $1.key }.map {
          ["path": $0.key, "size": $0.value.count, "modified": 1794304800000.0, "version": fileHash($0.value)]
        } : []
        sources.append(["id": source, "kind": saved ? "saved" : "original", "label": saved ? "Sample saved host copy" : "Sample original environment",
          "binding": fileBinding(source, epoch: epoch), "sandboxId": saved ? NSNull() : sandboxId,
          "status": status, "detail": saved ? "Example host copy, not your actual files. The original fixture has additional files."
            : available ? "Sample original is running. Browse and save these example files; no cloud environment was started."
            : status == "stopped" ? "Start the sample environment explicitly to reveal its example files."
            : "Sample original is unavailable: unknown start, custody hold or deletion. No automatic start or source fallback.",
          "files": files, "truncated": false, "skippedEntries": 0])
      }
    }
    return try decode(["version": 1, "podId": id, "generation": epoch, "sources": sources,
      "limits": ["maxFileBytes": 5 * 1024 * 1024, "maxSelectionBytes": 50 * 1024 * 1024, "maxFiles": 2000],
      "excludes": [".git", ".env*", "credential locations", "caches", "symlinks and special files"]])
  }

  /// Capture one scenario epoch so a menu change cannot retarget an open decision.
  public func applying(to base: PodActions) -> PodActions {
    let epoch = generation
    let scope = "recovery-preview:\(session):\(epoch)"
    var actions = base
    actions.fileRecovery = FileRecoveryActions(scope: scope, isFixture: true,
      isCurrent: { self.generation == epoch }, load: { id, includeOriginal in try self.inspectFiles(id, epoch: epoch, includeOriginal: includeOriginal) },
      read: { id, selection in
        let snapshot = try self.inspectFiles(id, epoch: epoch, includeOriginal: true)
        guard selection.generation == epoch,
          let source = snapshot.sources.first(where: { $0.id == selection.sourceId && $0.binding == selection.binding && $0.status == .available }),
          source.files.contains(where: { $0.path == selection.path && $0.version == selection.version }),
          let data = self.fileData(source.id)[selection.path] else { throw self.unavailable() }
        return try self.decode(["path": selection.path, "size": data.count, "encoding": "base64", "content": data.base64EncodedString(), "sha256": self.fileHash(data)])
      })
    actions.sandboxRecovery = SandboxRecoveryActions(scope: scope, draftScope: scope,
      journalDirectory: journalDirectory.appendingPathComponent("sandbox", isDirectory: true),
      isCurrent: { self.generation == epoch },
      load: { id in try self.inspect(id, epoch: epoch) },
      submit: { id, request in try self.submit(id, request, epoch: epoch) })
    actions.stalledWorkerRecovery = StalledWorkerRecoveryActions(scope: scope, draftScope: scope,
      journalDirectory: journalDirectory.appendingPathComponent("stalled", isDirectory: true),
      isCurrent: { self.generation == epoch }, load: { id in
        try self.requireCurrent(epoch)
        return try self.decode(["schemaVersion": 1, "podId": id, "generation": epoch, "status": "failed",
          "binding": String(repeating: "a", count: 64), "canStop": false,
          "blockers": ["Sample data only: there is no Docker execution to stop."], "operation": NSNull()])
      }, submit: { _, _ in throw self.unavailable() })
    actions.retainedFinalization = RetainedFinalizationActions(scope: scope, draftScope: scope,
      journalDirectory: journalDirectory.appendingPathComponent("finalization", isDirectory: true), load: { id in
        try self.requireCurrent(epoch)
        return try self.decode(["podId": id, "generation": epoch, "status": "failed",
          "binding": String(repeating: "a", count: 64),
          "custody": self.scenario == .held ? [["kind": "sample-source", "id": "preview-custody"]] : [],
          "canStop": false, "canCompleteMerged": false,
          "blockers": ["Sample data only: no actual task completion or PR merge can be verified."], "operation": NSNull()])
      }, submit: { _, _ in throw self.unavailable() })
    var repair = RepairContinuationActions(scope: scope, draftScope: scope,
      journalDirectory: journalDirectory.appendingPathComponent("repair", isDirectory: true),
      isCurrent: { self.generation == epoch }, load: { id in
        try self.requireCurrent(epoch)
        return try self.decode(["version": 1, "intent": "qualify_then_code_once", "podId": id,
          "generation": epoch, "available": false, "expectedResultHash": NSNull(),
          "expectedReportSetHash": NSNull(), "sourceHead": NSNull(), "requirementsHash": NSNull(), "operation": NSNull(),
          "refusals": [["code": "unavailable", "message": "Sample data cannot provision or qualify a replacement or start coding."]]])
      }, preview: { _, _, _ in throw self.unavailable() }, submit: { _, _ in throw self.unavailable() },
      observe: { _, _ in throw self.unavailable() })
    repair.context = { _ in
      try self.requireCurrent(epoch)
      var context = RepairContinuationContext()
      context.retained = try self.decode(["inspection": ["generation": epoch,
        "infrastructure": ["state": "reported", "truncated": false, "needs": []],
        "prerequisites": ["sourcePreservationRecorded": true,
          "workerSettlementRecorded": self.scenario != .unknownStart, "pendingDecision": false]]])
      context.unavailable = ["Sample data has no live budget or execution accounting."]
      return context
    }
    actions.repairContinuation = repair
    actions.loadValidationRecovery = { _ in
      try self.requireCurrent(epoch)
      let unavailable = ValidationRecoveryAvailability(allowed: false,
        reason: "Sample data only: no checks or coding will run.", code: "PREVIEW_ONLY")
      return ValidationRecoveryState(generation: epoch, validationTimestamp: self.date,
        fixValidation: unavailable, retryChecks: unavailable)
    }
    actions.requestValidationRecovery = { _, _ in throw self.unavailable() }
    return actions
  }
}
