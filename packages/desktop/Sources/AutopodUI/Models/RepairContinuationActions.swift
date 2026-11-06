import AutopodClient
import Foundation
import Observation

/// Read-only context is explanatory, never proof or an admission decision.
public struct RepairContinuationContext: Sendable {
  public var retained: RepairRetainedContext?
  public var budget: TaskExecutionSummary?
  public var retries: [TaskRetryState] = []
  public var unavailable: [String] = []
  public init() {}
}

public struct RepairContinuationActions: Sendable {
  public let scope: String
  public let draftScope: String
  public let journalDirectory: URL?
  public let available: Bool
  public let isCurrent: @MainActor @Sendable () -> Bool
  public let load: @MainActor @Sendable (String) async throws -> RepairContinuationInspectionV1
  public let preview: @MainActor @Sendable (String, String, String) async throws -> RepairContinuationPreviewV1
  public let submit: @MainActor @Sendable (String, RepairContinuationRequestV1) async throws -> RepairContinuationOperationV1
  public let observe: @MainActor @Sendable (String, String) async throws -> RepairContinuationOperationV1
  public var context: @MainActor @Sendable (String) async throws -> RepairContinuationContext = { _ in
    var value = RepairContinuationContext(); value.unavailable = ["Original reports and accounting unavailable on this connection."]; return value
  }

  public init(scope: String, draftScope: String, journalDirectory: URL? = nil, available: Bool = true,
    isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    load: @escaping @MainActor @Sendable (String) async throws -> RepairContinuationInspectionV1,
    preview: @escaping @MainActor @Sendable (String, String, String) async throws -> RepairContinuationPreviewV1,
    submit: @escaping @MainActor @Sendable (String, RepairContinuationRequestV1) async throws -> RepairContinuationOperationV1,
    observe: @escaping @MainActor @Sendable (String, String) async throws -> RepairContinuationOperationV1) {
    self.scope = scope; self.draftScope = draftScope; self.journalDirectory = journalDirectory
    self.available = available; self.isCurrent = isCurrent; self.load = load; self.preview = preview
    self.submit = submit; self.observe = observe
  }
  public static let unavailable = Self(scope: "unavailable", draftScope: "unavailable", available: false,
    load: { _ in throw URLError(.unsupportedURL) }, preview: { _, _, _ in throw URLError(.unsupportedURL) },
    submit: { _, _ in throw URLError(.unsupportedURL) }, observe: { _, _ in throw URLError(.unsupportedURL) })
}

/// Conditional authority is not qualification. All effects remain daemon-owned.
@Observable @MainActor internal final class RepairContinuationModel {
  let podId: String
  private let scope: String
  private let journal: RepairContinuationJournal<RepairContinuationRequestV1>
  private var journalLoaded = false
  private var journalInvalid = false
  var hostHead = ""
  var profileId = ""
  var reason = ""
  private(set) var snapshot: RepairContinuationInspectionV1?
  private(set) var preview: RepairContinuationPreviewV1?
  private(set) var context: RepairContinuationContext?
  private(set) var pending: RepairContinuationRequestV1?
  private(set) var operation: RepairContinuationOperationV1?
  private(set) var busy = false
  private(set) var error: String?

  init(podId: String, actions: RepairContinuationActions) {
    self.podId = podId; scope = actions.scope
    journal = RepairContinuationJournal(scope: actions.draftScope, podId: podId, directory: actions.journalDirectory)
  }

  var canPreview: Bool {
    !busy && !journalInvalid && pending == nil && snapshot?.available == true && snapshot?.operation == nil
      && profileId.utf16.count <= 128 && profileId.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", options: .regularExpression) != nil
      && hostHead.range(of: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", options: .regularExpression) != nil
  }
  var canAuthorize: Bool {
    let length = reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    guard canPreview, (10...4000).contains(length), let snapshot, snapshot.refusals.isEmpty, let preview,
      preview.conditionalAttemptEligible, preview.configurationOnly, preview.actualQualification == "not_run",
      preview.refusals.isEmpty, preview.configurationDiff != nil, let selected = preview.selection else { return false }
    // Inspection deliberately does not read host source. The successful source-checked
    // preview binds the exact user HEAD; a provided inspection HEAD must still agree.
    return selected.sourceHead == hostHead && (snapshot.sourceHead == nil || selected.sourceHead == snapshot.sourceHead)
      && selected.executionProfileId == profileId && selected.expectedGeneration == snapshot.generation
      && selected.expectedResultHash == snapshot.expectedResultHash && selected.expectedReportSetHash == snapshot.expectedReportSetHash
      && selected.requirementsHash == snapshot.requirementsHash
  }

  func refresh(_ actions: RepairContinuationActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; preview = nil; snapshot = nil; context = nil
    defer { busy = false }
    do {
      if !journalLoaded {
        do {
          pending = try journal.load()
          try pending?.validate()
          if let pending { hostHead = pending.sourceHead; profileId = pending.executionProfileId; reason = pending.reason }
          journalLoaded = true
        } catch {
          journalInvalid = true
          throw DaemonError.badRequest("Saved repair request is unreadable; preserve it for inspection. No authorization will be sent.")
        }
      }
      let value = try await actions.load(podId)
      guard bind(actions) else { return }
      try value.validate(podId: podId)
      snapshot = value
      if hostHead.isEmpty { hostHead = value.sourceHead ?? "" }
      if let recorded = value.operation {
        if let pending { try recorded.validate(podId: podId, requestId: pending.id, expected: pending) }
        else {
          try journal.save(recorded.request); pending = recorded.request
          hostHead = recorded.request.sourceHead; profileId = recorded.request.executionProfileId; reason = recorded.request.reason
        }
        operation = recorded
      }
      if let pending {
        let observed = try await actions.observe(podId, pending.id)
        guard bind(actions) else { return }
        try accept(observed, expected: pending)
      }
      let details = try await actions.context(podId)
      guard bind(actions) else { return }
      context = details
    } catch {
      guard bind(actions) else { return }
      self.error = "Inspection unavailable: \(error.localizedDescription). No fallback to Rework, Resume or checks-only. Saved requests remain retained."
    }
  }

  func loadPreview(_ actions: RepairContinuationActions) async {
    guard canPreview, bind(actions) else { return }
    let head = hostHead; let profile = profileId
    busy = true; preview = nil; error = nil
    defer { busy = false }
    do {
      let value = try await actions.preview(podId, head, profile)
      guard bind(actions), head == hostHead, profile == profileId else { return }
      try value.validate(podId: podId, sourceHead: head, profileId: profile)
      preview = value
    } catch {
      guard bind(actions) else { return }
      self.error = "Configuration preview unavailable: \(error.localizedDescription). No qualification or coding authorized."
    }
  }

  func authorize(_ actions: RepairContinuationActions) async {
    guard canAuthorize, bind(actions), let selection = preview?.selection else { return }
    let request = RepairContinuationRequestV1(id: UUID().uuidString, selection: selection,
      reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
    busy = true; error = nil
    defer { busy = false }
    do {
      try request.validate()
      try journal.save(request) // Durable exact body BEFORE the only POST.
      pending = request
    } catch {
      journalInvalid = true
      self.error = "Could not preserve exact repair request; nothing was sent: \(error.localizedDescription)"
      return
    }
    do {
      let value = try await actions.submit(podId, request)
      guard bind(actions) else { return }
      try accept(value, expected: request)
    } catch {
      guard bind(actions) else { return }
      self.error = "Authorization outcome unconfirmed: \(error.localizedDescription). Observe saved request \(request.id); do not submit a new key."
    }
  }

  func observe(_ actions: RepairContinuationActions) async {
    guard !busy, bind(actions), let pending else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      let value = try await actions.observe(podId, pending.id)
      guard bind(actions) else { return }
      try accept(value, expected: pending)
    } catch {
      guard bind(actions) else { return }
      self.error = "Outcome remains unconfirmed: \(error.localizedDescription). The exact saved request is retained; absence is not proof that dispatch failed."
    }
  }

  private func accept(_ value: RepairContinuationOperationV1, expected: RepairContinuationRequestV1) throws {
    try value.validate(podId: podId, requestId: expected.id, expected: expected)
    operation = value
  }
  private func bind(_ actions: RepairContinuationActions) -> Bool {
    guard actions.available, actions.scope == scope, actions.isCurrent() else {
      snapshot = nil; preview = nil; context = nil; operation = nil
      error = "Connection changed or unavailable. Reopen repair continuation on the owning daemon; the saved request was not discarded."
      return false
    }
    return true
  }
}
