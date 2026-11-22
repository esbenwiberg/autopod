import AutopodClient
import Foundation
import Observation

public struct RetainedCleanupActions: Sendable {
  public let scope: String
  public let connection: String
  public let journalDirectory: URL?
  public let available: Bool
  public let isCurrent: @MainActor @Sendable () -> Bool
  public let inspect: @MainActor @Sendable (String) async throws -> RetainedCleanupInspection
  public let observe: @MainActor @Sendable (String, String) async throws -> RetainedCleanupReceipt
  public let submit: @MainActor @Sendable (String, RetainedCleanupRequest) async throws -> RetainedCleanupSubmission
  public let confirmDeleted: @MainActor @Sendable (RetainedCleanupReceipt) -> Void

  public init(scope: String, connection: String, journalDirectory: URL? = nil, available: Bool = true,
              isCurrent: @escaping @MainActor @Sendable () -> Bool,
              inspect: @escaping @MainActor @Sendable (String) async throws -> RetainedCleanupInspection,
              observe: @escaping @MainActor @Sendable (String, String) async throws -> RetainedCleanupReceipt,
              submit: @escaping @MainActor @Sendable (String, RetainedCleanupRequest) async throws -> RetainedCleanupSubmission,
              confirmDeleted: @escaping @MainActor @Sendable (RetainedCleanupReceipt) -> Void = { _ in }) {
    self.scope = scope; self.connection = connection; self.journalDirectory = journalDirectory
    self.available = available; self.isCurrent = isCurrent
    self.inspect = inspect; self.observe = observe; self.submit = submit; self.confirmDeleted = confirmDeleted
  }

  public static let unavailable = Self(scope: "unavailable", connection: "unavailable", available: false,
    isCurrent: { false }, inspect: { _ in throw RetainedCleanupError.unsupported },
    observe: { _, _ in throw RetainedCleanupError.unsupported }, submit: { _, _ in throw RetainedCleanupError.unsupported })
}

@MainActor @Observable final class RetainedCleanupModel {
  private struct Saved: Codable, Equatable {
    let version: Int
    let connection: String
    let podId: String
    let request: RetainedCleanupRequest
    let planFingerprint: String
  }

  let podId: String
  private let scope: String
  private let connection: String
  private let journal: RepairContinuationJournal<Saved>
  private var saved: Saved?
  private var journalInvalid = false
  private var remoteRequestId: String?
  private var canReplayAfterObservation = false
  private(set) var inspection: RetainedCleanupInspection?
  private(set) var receipt: RetainedCleanupReceipt?
  private(set) var busy = false
  private(set) var error: String?
  private(set) var postBlockers: [RetainedCleanupBlocker]?
  var reason = ""
  var acknowledgesLoss = false

  init(podId: String, actions: RetainedCleanupActions) {
    self.podId = podId; scope = actions.scope; connection = actions.connection
    let folder = actions.journalDirectory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/retained-cleanup-v1", isDirectory: true)
    journal = .init(scope: connection, podId: podId, directory: folder, label: "cleanup")
    if actions.available && actions.isCurrent() { restoreJournal() }
  }

  var pending: RetainedCleanupRequest? { saved?.request }
  var requestId: String? { pending?.id ?? remoteRequestId }
  var needsObservation: Bool { journalInvalid || (requestId != nil && receipt?.state != .deleted) }
  var plan: RetainedCleanupPlan? { receipt?.plan ?? inspection?.plan }
  var blockers: [RetainedCleanupBlocker] { postBlockers ?? receipt?.blockers ?? inspection?.blockers ?? [] }
  var canReconcile: Bool { !busy && !journalInvalid && saved != nil && canReplayAfterObservation && receipt?.state != .deleted }
  var canSubmit: Bool {
    !busy && !journalInvalid && requestId == nil && inspection?.state == .eligible
      && acknowledgesLoss && (10...4000).contains(RetainedCleanupRequest.normalizedReason(reason).utf16.count)
  }

  func refresh(_ actions: RetainedCleanupActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; acknowledgesLoss = false; reason = ""; postBlockers = nil
    canReplayAfterObservation = false
    defer { busy = false }
    let observedKey = requestId
    inspection = nil
    restoreJournal()
    guard !journalInvalid else { return }
    do {
      if let key = saved?.request.id ?? observedKey {
        try await observe(key, actions: actions)
        return
      }
      let value = try await actions.inspect(podId)
      guard bind(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId)
      inspection = value
      if let key = value.requestId {
        remoteRequestId = key
        try await observe(key, actions: actions)
      }
    } catch RetainedCleanupError.notFound where saved != nil {
      // Exact GET returned no receipt. This is not permission to create a new ID.
      guard bind(actions), !Task.isCancelled else { return }
      canReplayAfterObservation = true
      error = "No receipt is visible for this request yet. This is not proof of failure. If needed, reconcile the exact saved request as the original operator."
    } catch {
      guard bind(actions), !Task.isCancelled else { return }
      self.error = error.localizedDescription
    }
  }

  func apply(reviewed: RetainedCleanupPlan, actions: RetainedCleanupActions) async {
    guard bind(actions), canSubmit else { return }
    do {
      let fingerprint = try reviewed.fingerprint()
      guard try fingerprint == inspection?.plan?.fingerprint() else { throw RetainedCleanupError.invalidReply }
      // Re-read before admitting an intent from a second open surface.
      restoreJournal()
      guard canSubmit else { return }
      let request = RetainedCleanupRequest(id: UUID().uuidString, plan: reviewed, reason: reason)
      guard request.valid else { throw RetainedCleanupError.invalidReply }
      let record = Saved(version: 1, connection: connection, podId: podId, request: request,
        planFingerprint: fingerprint)
      try journal.save(record)
      saved = record
      await send(record, actions: actions)
    } catch {
      restoreJournal()
      self.error = "Could not preserve the exact request; nothing was sent. \(error.localizedDescription)"
      acknowledgesLoss = false
      inspection = nil
    }
  }

  func reconcile(_ actions: RetainedCleanupActions) async {
    guard bind(actions), canReconcile, let saved else { return }
    restoreJournal()
    guard self.saved == saved, !journalInvalid else { return }
    await send(saved, actions: actions)
  }

  private func send(_ record: Saved, actions: RetainedCleanupActions) async {
    guard bind(actions) else { return }
    busy = true; error = nil; canReplayAfterObservation = false; acknowledgesLoss = false
    postBlockers = nil
    defer { busy = false }
    do {
      let outcome = try await actions.submit(podId, record.request)
      guard bind(actions), !Task.isCancelled else { return }
      switch outcome {
      case .blocked(let value):
        try value.validate(podId: podId)
        guard value.state == .blocked else { throw RetainedCleanupError.invalidReply }
        inspection = value
        postBlockers = value.blockers
        error = "Cleanup was blocked; this submission removed nothing. The exact request is still saved."
      case .receipt(let value):
        try accept(value, key: record.request.id, actions: actions)
        canReplayAfterObservation = value.state != .deleted
      }
    } catch {
      guard bind(actions), !Task.isCancelled else { return }
      self.error = "\(error.localizedDescription) Outcome unconfirmed. Check the saved request before reconciling. Do not use another request ID."
    }
  }

  private func observe(_ key: String, actions: RetainedCleanupActions) async throws {
    let value = try await actions.observe(podId, key)
    guard bind(actions), !Task.isCancelled else { return }
    try accept(value, key: key, actions: actions)
    canReplayAfterObservation = value.state != .deleted
  }

  private func accept(_ value: RetainedCleanupReceipt, key: String, actions: RetainedCleanupActions) throws {
    try value.validate(podId: podId, requestId: key, expectedRequest: saved?.request,
      expectedPlan: saved?.planFingerprint)
    receipt = value
    if value.state == .deleted { actions.confirmDeleted(value) }
  }

  private func restoreJournal() {
    do {
      let value = try journal.load()
      if let value {
        guard value.version == 1, value.connection == connection, value.podId == podId, value.request.valid,
          value.planFingerprint.count == 64, saved == nil || value == saved
        else { throw RetainedCleanupError.invalidReply }
      } else if saved != nil { throw RetainedCleanupError.invalidReply }
      saved = value
      journalInvalid = false
    } catch {
      journalInvalid = true
      self.error = "The saved cleanup journal cannot be verified. Keep it for inspection; no new request can be sent."
    }
  }

  private func bind(_ actions: RetainedCleanupActions) -> Bool {
    guard actions.available, actions.scope == scope, actions.isCurrent() else {
      inspection = nil
      acknowledgesLoss = false
      canReplayAfterObservation = false
      error = actions.available ? "Connection changed. Reopen cleanup on the original daemon." : RetainedCleanupError.unsupported.localizedDescription
      return false
    }
    return true
  }
}
