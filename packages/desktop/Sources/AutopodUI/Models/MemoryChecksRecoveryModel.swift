import AutopodClient
import Foundation
import Observation

public struct MemoryChecksActions: Sendable {
  public var scope: String
  public var draftScope: String
  public var journalDirectory: URL?
  public var available: Bool
  public var isCurrent: @MainActor @Sendable () -> Bool
  public var load: @MainActor @Sendable (String) async throws -> MemoryChecksInspection
  public var preview: @MainActor @Sendable (String, String) async throws -> MemoryChecksPreview
  public var submit: @MainActor @Sendable (String, MemoryChecksRequest) async throws -> MemoryChecksOperation
  public init(scope: String, draftScope: String, journalDirectory: URL? = nil, available: Bool = true,
    isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    load: @escaping @MainActor @Sendable (String) async throws -> MemoryChecksInspection,
    preview: @escaping @MainActor @Sendable (String, String) async throws -> MemoryChecksPreview,
    submit: @escaping @MainActor @Sendable (String, MemoryChecksRequest) async throws -> MemoryChecksOperation) {
    self.scope = scope; self.draftScope = draftScope; self.journalDirectory = journalDirectory
    self.available = available; self.isCurrent = isCurrent; self.load = load; self.preview = preview; self.submit = submit
  }
  public static let unavailable = Self(scope: "unavailable", draftScope: "unavailable", available: false,
    load: { _ in throw URLError(.unsupportedURL) }, preview: { _, _ in throw URLError(.unsupportedURL) },
    submit: { _, _ in throw URLError(.unsupportedURL) })
}

@MainActor @Observable final class MemoryChecksRecoveryModel {
  let podId: String
  private let scope: String
  private let journal: RepairContinuationJournal<MemoryChecksRequest>
  private var loaded = false
  private(set) var invalid = false
  private(set) var stale = false
  private(set) var busy = false
  private(set) var assessment: MemoryChecksInspection.Assessment?
  private(set) var preview: MemoryChecksPreview?
  private(set) var pending: MemoryChecksRequest?
  private(set) var operation: MemoryChecksOperation?
  private(set) var error: String?
  var profileId = "" { didSet { if oldValue != profileId { preview = nil } } }
  var reason = ""
  var confirmed = false

  init(podId: String, actions: MemoryChecksActions) {
    self.podId = podId; scope = actions.scope
    journal = RepairContinuationJournal(scope: "memory-checks:\(actions.draftScope)", podId: podId, directory: actions.journalDirectory)
  }
  var memory: MemoryChecksInspection.Memory? { assessment?.memoryRecovery }
  var hasSavedRequest: Bool { invalid || pending != nil }
  var needsObservation: Bool { invalid || (pending != nil && operation?.checked == nil) }
  var canPreview: Bool {
    !busy && !invalid && !stale && pending == nil && memory?.version == 1
      && memory?.state == "requires_candidate" && memory?.candidateQualification == "not_run"
      && memory?.source != nil && memory?.predecessorId != nil && memory?.priorMemory != nil
      && assessment?.selection?.expectedGeneration == assessment?.generation
      && profileId.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil
  }
  var canConfirm: Bool {
    canPreview && confirmed && preview?.profileId == profileId && preview?.target == "local"
      && preview?.main.memoryGb.map { $0.isFinite && $0 > 0 } == true
      && makeRequest(id: "validation") != nil
  }
  var savedWork: String {
    guard !stale, let source = memory?.source else { return "Exact saved source is unavailable. Keep the retained environment and evidence." }
    return "Saved commit \(source.head). No complete passing test report. The earlier failed result remains in history."
  }
  var nextStep: String {
    if stale { return "The task or connection changed. Inspect again before selecting a candidate." }
    if needsObservation { return "Observe the saved request. A lost reply does not permit another dispatch." }
    return memory?.reason ?? error ?? "Memory recovery assessment is unavailable on this connection."
  }
  var outcome: String {
    if let blocked = operation?.blocked { return "Checks were not certified: \(blocked.code). Original evidence remains retained." }
    if operation?.checked?.result.overall == "pass" { return "Fresh checks passed. Separate human approval is required; nothing was delivered." }
    if operation?.checked != nil { return "Fresh checks did not pass. The earlier failure remains in history." }
    if operation?.checking != nil { return "Checks dispatch recorded. No certified result yet; observe this request." }
    if operation?.activated != nil { return "Candidate queued. Actual memory qualification and retry admission are still required." }
    return "Outcome unconfirmed. Observe the exact saved request; no automatic replay."
  }
  func invalidate() { stale = true; preview = nil; confirmed = false }
  private func bind(_ actions: MemoryChecksActions) -> Bool {
    guard actions.scope == scope, actions.available, actions.isCurrent() else { invalidate(); return false }
    return true
  }
  func refresh(_ actions: MemoryChecksActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; preview = nil; confirmed = false; error = nil; stale = true; assessment = nil
    defer { busy = false }
    do {
      if !loaded {
        do { pending = try journal.load(); try pending?.validate(); loaded = true }
        catch { invalid = true; throw error }
      }
      let value = try await actions.load(podId)
      guard bind(actions) else { return }
      assessment = value.inspection; stale = false
      if let pending {
        guard let recorded = value.operations.first(where: { $0.id == pending.id }) else {
          throw DaemonError.badRequest("Saved request not observed. Absence does not authorize replay.")
        }
        try recorded.validate(podId: podId, request: pending); operation = recorded
      } else if value.operations.contains(where: { $0.binding.continuation?.infrastructure?.predecessorChecksId != nil && $0.checked == nil && $0.blocked == nil }) {
        // A different Mac may own the request. Never silently create a competing one.
        stale = true; error = "A retained checks request already exists. Inspect its owning handoff before another decision."
      }
    } catch { self.error = "Inspection unavailable: \(error.localizedDescription)" }
  }
  func loadPreview(_ actions: MemoryChecksActions) async {
    guard canPreview, bind(actions) else { return }
    let profile = profileId
    busy = true; preview = nil; confirmed = false
    defer { busy = false }
    do {
      let value = try await actions.preview(podId, profile)
      guard bind(actions), profileId == profile, value.profileId == profile, value.target == "local" else { return }
      preview = value
    } catch { self.error = "Candidate configuration unavailable: \(error.localizedDescription)" }
  }
  private func makeRequest(id: String) -> MemoryChecksRequest? {
    guard let selection = assessment?.selection, let head = memory?.source?.head, let preview else { return nil }
    let request = MemoryChecksRequest(id: id, generation: selection.expectedGeneration, resultHash: selection.expectedResultHash,
      head: head, profile: profileId, digest: preview.digest, reason: reason)
    return (try? request.validate()) != nil ? request : nil
  }
  func submit(_ actions: MemoryChecksActions) async {
    guard canConfirm, bind(actions), let request = makeRequest(id: UUID().uuidString) else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      // Refresh identity before preserving the single POST; a preview is never execution proof.
      let current = try await actions.load(podId)
      guard bind(actions), current.inspection?.generation == request.expectedGeneration,
        current.inspection?.selection?.expectedResultHash == request.expectedResultHash,
        current.inspection?.memoryRecovery?.source?.head == request.checkpointHead,
        current.inspection?.memoryRecovery?.source?.tree == memory?.source?.tree,
        current.inspection?.memoryRecovery?.state == "requires_candidate" else { invalidate(); return }
      do { try journal.save(request); pending = request }
      catch {
        invalid = true
        self.error = "Could not preserve the exact checks request; nothing was sent: \(error.localizedDescription)"
        return
      }
      let value = try await actions.submit(podId, request)
      guard bind(actions) else { return }
      try value.validate(podId: podId, request: request); operation = value
    } catch { self.error = "Outcome unconfirmed: \(error.localizedDescription). Observe the saved request; do not create another ID." }
  }
}
