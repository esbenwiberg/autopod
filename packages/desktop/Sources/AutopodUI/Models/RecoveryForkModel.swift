import AutopodClient
import Foundation
import Observation

/// Owns a single immutable continuation decision. A lost response permits observation,
/// not a second POST or a new pod. This controller grants no source/deletion authority.
@MainActor @Observable final class RecoveryForkModel {
  let podId: String
  private let scope: String
  private let draftScope: String
  private let directory: URL?
  private let journal: RepairContinuationJournal<RecoveryForkRequest>
  private(set) var inspection: RecoveryForkInspection?
  private(set) var preview: RecoveryForkPreview?
  private(set) var operation: RecoveryForkOperation?
  private(set) var pending: RecoveryForkRequest?
  private(set) var busy = false
  private(set) var error: String?
  private(set) var invalidJournal = false
  private var rejected: RecoveryForkRequest?
  private var confirmedAbsent = false
  var instructions = "" { didSet { preview = nil } }
  var profileId = "@original" { didSet { preview = nil } }
  var acknowledged = false { didSet { preview = nil } }
  private(set) var selectedPaths: Set<String> = []

  init(podId: String, actions: RecoveryForkActions) {
    self.podId = podId; scope = actions.scope; draftScope = actions.draftScope
    directory = actions.journalDirectory
    journal = RepairContinuationJournal(scope: actions.draftScope + "\0recovery-fork", podId: podId, directory: actions.journalDirectory)
    do {
      pending = try journal.load()
      if let pending {
        guard pending.isValid else { throw DaemonError.badRequest("Saved continuation decision is invalid. Retain it for inspection.") }
        rejected = try rejectionJournal(pending).load()
        guard rejected == nil || rejected == pending else { throw DaemonError.badRequest("Saved rejection does not match the continuation decision.") }
        instructions = pending.instructions; profileId = pending.executionProfileId
        acknowledged = pending.acknowledgePartialSource; selectedPaths = Set(pending.files.map(\.path))
      }
    } catch { invalidJournal = true; self.error = error.localizedDescription }
  }
  var context: RecoveryForkContext? {
    if let operation { return operation.context }
    if let pending {
      guard let preview, preview.expectedBinding == pending.expectedBinding, preview.input == pending.input else { return nil }
      return preview.context
    }
    return preview?.context ?? inspection?.context
  }
  var selectionIssue: String? {
    if selectedPaths.count > 100 { return "Select at most 100 additional files." }
    if selectedBytes > 50 * 1024 * 1024 { return "Selected files exceed 50 MiB. Remove files before review." }
    if instructions.utf16.count > 8000 { return "Shorten continuation instructions to 8,000 characters." }
    return nil
  }
  var needsObservation: Bool {
    pending != nil && (operation == nil || [.preparing, .unknown].contains(operation?.state))
  }
  var canEdit: Bool { !busy && !invalidJournal && pending == nil && operation == nil }
  var selectedBytes: Int64 { inspection?.source?.files.filter { selectedPaths.contains($0.path) }.reduce(0) { $0 + $1.size } ?? 0 }
  var input: RecoveryForkInput? {
    guard let inspection, let source = inspection.source else { return nil }
    let files = source.files.filter { selectedPaths.contains($0.path) }.sorted { $0.path < $1.path }
      .map { RecoveryForkSelectedFile(path: $0.path, version: $0.version) }
    guard files.count == selectedPaths.count, selectedBytes <= 50 * 1024 * 1024 else { return nil }
    return RecoveryForkInput(expectedGeneration: inspection.generation, sourceHead: source.head,
      executionProfileId: profileId, instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
      files: files, acknowledgePartialSource: acknowledged)
  }
  var canPreview: Bool { canEdit && inspection?.available == true && input?.isValid == true }
  var canCreate: Bool { canPreview && preview?.available == true && preview?.input == input && preview?.expectedBinding != nil }
  var canDiscardRejected: Bool { !busy && !invalidJournal && pending != nil && pending == rejected && confirmedAbsent && operation == nil }
  func editReview() { if canEdit { preview = nil } }
  func select(_ path: String, selected: Bool) {
    guard canEdit, inspection?.source?.files.contains(where: { $0.path == path }) == true else { return }
    if selected { selectedPaths.insert(path) } else { selectedPaths.remove(path) }; preview = nil
  }
  func refresh(_ actions: RecoveryForkActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; defer { busy = false }
    do {
      let value = try await actions.inspect(podId)
      guard bind(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId)
      if let observed = value.operation {
        try observed.validate(podId: podId, request: pending)
        if let old = operation, old.id != observed.id { throw DaemonError.badRequest("A different durable decision owns this source. Observe it on the owning daemon.") }
        if pending == nil {
          do { try journal.save(observed.request); pending = observed.request }
          catch { invalidJournal = true; throw error }
        }
        operation = observed
      }
      if pending == nil && (inspection?.source != value.source || inspection?.generation != value.generation || inspection?.context != value.context) {
        preview = nil; selectedPaths = []
      }
      inspection = value
      if pending != nil { await observeCurrent(actions) }
    } catch { if bind(actions) { self.error = error.localizedDescription } }
  }
  func review(_ actions: RecoveryForkActions) async {
    guard canPreview, bind(actions), let input else { return }
    busy = true; preview = nil; error = nil; defer { busy = false }
    do {
      let value = try await actions.preview(podId, input)
      guard bind(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId, input: input)
      guard self.input == input else { throw DaemonError.badRequest("Selection changed. Review the continuation again.") }
      preview = value
    } catch { if bind(actions) { self.error = error.localizedDescription } }
  }
  func create(_ actions: RecoveryForkActions) async {
    guard canCreate, bind(actions), let preview, let binding = preview.expectedBinding else { return }
    let request = RecoveryForkRequest(expectedBinding: binding, input: preview.input)
    guard request.isValid else { error = "Decision exceeds the protected request limit. Shorten instructions or select fewer files."; return }
    do { try journal.save(request); pending = request }
    catch { invalidJournal = true; self.error = error.localizedDescription; return }
    busy = true; error = nil; confirmedAbsent = false
    defer { busy = false }
    do {
      let value = try await actions.create(podId, request)
      guard bind(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId, request: request); operation = value
    } catch {
      guard bind(actions) else { return }
      if let proof = error as? RecoveryForkRejection, proof.matches(podId: podId, request: request) {
        do { try rejectionJournal(request).save(request); rejected = request }
        catch { invalidJournal = true }
      }
      self.error = "\(error.localizedDescription) The decision is saved. Check its outcome; do not start another pod."
      let savedError = self.error
      await observeCurrent(actions)
      if let savedError { self.error = savedError }
    }
  }
  func observe(_ actions: RecoveryForkActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; defer { busy = false }
    await observeCurrent(actions)
  }
  private func observeCurrent(_ actions: RecoveryForkActions) async {
    guard let id = pending?.id ?? operation?.id else { return }
    confirmedAbsent = false
    do {
      let value = try await actions.observe(podId, id)
      guard bind(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId, request: pending)
      guard value.id == id else { throw URLError(.badServerResponse) }
      operation = value
    } catch {
      guard bind(actions) else { return }
      if let daemon = error as? DaemonError, case .notFound = daemon {
        confirmedAbsent = true
        self.error = rejected == pending && rejected != nil
          ? "The daemon rejected this exact decision and confirms no operation exists. You can explicitly review a new decision."
          : "No operation is recorded for the saved decision. Its outcome is still unknown; a new pod was not requested."
      } else { self.error = "\(error.localizedDescription) Saved outcome remains unconfirmed." }
    }
  }
  func discardRejected(_ actions: RecoveryForkActions) async {
    guard canDiscardRejected, bind(actions), let pending else { return }
    await observe(actions)
    guard canDiscardRejected, bind(actions), rejected == pending else { return }
    do {
      guard try journal.load() == pending, try rejectionJournal(pending).load() == pending else { throw DaemonError.badRequest("Saved decision changed. Nothing was discarded.") }
      try FileManager.default.removeItem(at: journal.url)
      try FileManager.default.removeItem(at: rejectionJournal(pending).url)
      self.pending = nil; rejected = nil; confirmedAbsent = false; preview = nil
      await refresh(actions)
    } catch { invalidJournal = true; self.error = error.localizedDescription }
  }
  func open(_ actions: RecoveryForkActions, parent: Bool = false) async -> Bool {
    guard !busy, bind(actions), let id = parent ? inspection?.lineage?.parentPodId : operation?.childPodId else { return false }
    busy = true; defer { busy = false }
    do { try await actions.openPod(id); return bind(actions) }
    catch { if bind(actions) { self.error = error.localizedDescription }; return false }
  }
  private func rejectionJournal(_ value: RecoveryForkRequest) -> RepairContinuationJournal<RecoveryForkRequest> {
    RepairContinuationJournal(scope: draftScope + "\0recovery-fork-verified-rejection-v1\0" + value.id, podId: podId, directory: directory)
  }
  private func bind(_ actions: RecoveryForkActions) -> Bool {
    guard actions.available, actions.scope == scope, actions.isCurrent() else {
      inspection = nil; preview = nil; error = "Connection changed. Reopen on the owning daemon. Saved decisions and originals remain retained."
      return false
    }
    return true
  }
}
