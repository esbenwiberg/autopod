import AutopodClient
import Foundation
import Observation

public struct ValidationHeldDockerActions: Sendable {
  public var scope: String = "unavailable"
  public var connection: String = "unavailable"
  public var journalDirectory: URL?
  public var isCurrent: @MainActor @Sendable () -> Bool = { false }
  public var inspect: @MainActor @Sendable (String, String?) async throws -> ValidationHeldDockerView = { _, _ in throw RetainedCleanupError.unsupported }
  public var submit: @MainActor @Sendable (String, RetainedFinalizationRequest) async throws -> ValidationHeldDockerView = { _, _ in throw RetainedCleanupError.unsupported }
  public init() {}
}

@MainActor @Observable final class ValidationHeldDockerModel {
  struct Saved: Codable, Equatable {
    let connection: String
    let podId: String
    let request: RetainedFinalizationRequest
  }
  let podId: String
  private let scope: String
  private let connection: String
  private let journal: RepairContinuationJournal<Saved>
  private(set) var saved: Saved?
  private(set) var snapshot: ValidationHeldDockerView?
  private(set) var busy = false
  private(set) var error: String?
  private(set) var observed = false
  private var invalidJournal = false
  var reason = ""
  init(podId: String, actions: ValidationHeldDockerActions) {
    self.podId = podId; scope = actions.scope; connection = actions.connection
    journal = .init(scope: connection, podId: podId,
      directory: actions.journalDirectory ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autopod/validation-held-docker-v1"), label: "stop")
    restore()
  }
  var canSubmit: Bool { !busy && !invalidJournal && saved == nil && snapshot?.state == "eligible" && (10...4000).contains(RetainedCleanupRequest.normalizedReason(reason).utf16.count) }
  var needsObservation: Bool { invalidJournal || (saved != nil && snapshot?.state != "stopped") }
  private func restore() {
    do {
      let record = try journal.load()
      if let record {
        guard record.connection == connection, record.podId == podId,
          record.request.mode == .stopRetain, RetainedCleanupRequest.validId(record.request.requestKey),
          saved == nil || saved == record else { throw RetainedCleanupError.invalidReply }
      } else if saved != nil { throw RetainedCleanupError.invalidReply }
      saved = record
    } catch { invalidJournal = true; self.error = "The exact Stop journal cannot be verified. Retain it; no new request may be sent." }
  }
  private func current(_ actions: ValidationHeldDockerActions) -> Bool {
    actions.scope == scope && actions.connection == connection && actions.isCurrent()
  }
  func refresh(_ actions: ValidationHeldDockerActions) async {
    guard !busy, current(actions) else { return }
    restore(); guard !invalidJournal else { return }
    busy = true; observed = false; error = nil
    defer { busy = false }
    do {
      let value = try await actions.inspect(podId, saved?.request.requestKey)
      guard current(actions), !Task.isCancelled else { return }
      try accept(value)
      observed = true
    } catch RetainedCleanupError.notFound where saved != nil {
      guard current(actions), !Task.isCancelled else { return }
      observed = true
      error = "No receipt is visible for the exact saved key. This does not prove failure. You may explicitly reconcile only the same request as the original operator."
    } catch { self.error = error.localizedDescription }
  }
  func apply(_ actions: ValidationHeldDockerActions) async {
    guard current(actions), canSubmit, let s = snapshot, let generation = s.generation, let binding = s.binding else { return }
    restore(); guard canSubmit else { return }
    let request = RetainedFinalizationRequest(requestKey: UUID().uuidString, expectedGeneration: generation,
      expectedBinding: binding, mode: .stopRetain, reason: RetainedCleanupRequest.normalizedReason(reason))
    let record = Saved(connection: connection, podId: podId, request: request)
    do { try journal.save(record); saved = record }
    catch { restore(); self.error = "Could not journal Stop; nothing was sent."; return }
    await send(actions)
  }
  func reconcile(_ actions: ValidationHeldDockerActions) async {
    guard observed, saved != nil, snapshot?.state != "stopped" else { return }
    await send(actions)
  }
  private func send(_ actions: ValidationHeldDockerActions) async {
    guard !busy, current(actions), let saved, !invalidJournal else { return }
    busy = true; observed = false; error = nil
    defer { busy = false }
    do {
      let value = try await actions.submit(podId, saved.request)
      guard current(actions), !Task.isCancelled else { return }
      try accept(value)
    } catch { self.error = "Outcome unknown. Observe this exact saved request before reconciliation. \(error.localizedDescription)" }
  }
  private func accept(_ value: ValidationHeldDockerView) throws {
    try value.validate(podId: podId, key: saved?.request.requestKey)
    if let saved {
      guard value.binding == saved.request.expectedBinding, value.generation == saved.request.expectedGeneration
        else { throw RetainedCleanupError.invalidReply }
    }
    snapshot = value
  }
}
