import AutopodClient
import CryptoKit
import Foundation
import Observation

public struct StalledWorkerRecoveryActions: Sendable {
  public let scope: String
  public let draftScope: String
  public let journalDirectory: URL?
  public let available: Bool
  public let isCurrent: @MainActor @Sendable () -> Bool
  public let load: @MainActor @Sendable (String) async throws -> StalledWorkerRecoveryView
  public let submit: @MainActor @Sendable (String, StalledWorkerRecoveryRequest) async throws -> StalledWorkerRecoveryReceipt

  public init(scope: String, draftScope: String, journalDirectory: URL? = nil, available: Bool = true,
              isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
              load: @escaping @MainActor @Sendable (String) async throws -> StalledWorkerRecoveryView,
              submit: @escaping @MainActor @Sendable (String, StalledWorkerRecoveryRequest) async throws -> StalledWorkerRecoveryReceipt) {
    self.scope = scope; self.draftScope = draftScope; self.journalDirectory = journalDirectory
    self.available = available; self.isCurrent = isCurrent; self.load = load; self.submit = submit
  }

  public static let unavailable = Self(scope: "unavailable", draftScope: "unavailable", available: false,
    load: { _ in throw URLError(.unsupportedURL) }, submit: { _, _ in throw URLError(.unsupportedURL) })
}

/// An uncertain request survives sheet/app closure. Inspection never resubmits it.
@Observable @MainActor internal final class StalledWorkerRecoveryModel {
  let podId: String
  private let scope: String
  private let journalURL: URL
  private var journalLoaded = false
  private var journalInvalid = false
  private var rejected = false
  var reason = ""
  private(set) var snapshot: StalledWorkerRecoveryView?
  private(set) var pending: StalledWorkerRecoveryRequest?
  private(set) var receipt: StalledWorkerRecoveryReceipt?
  private(set) var busy = false
  private(set) var error: String?

  private struct Draft: Codable {
    let request: StalledWorkerRecoveryRequest
    let rejected: Bool
  }

  init(podId: String, actions: StalledWorkerRecoveryActions) {
    self.podId = podId; self.scope = actions.scope
    let identity = Data("\(actions.draftScope.utf8.count):\(actions.draftScope)\(podId)".utf8)
    let key = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    let folder = actions.journalDirectory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/retained-stalled-worker-recovery", isDirectory: true)
    self.journalURL = folder.appendingPathComponent("\(key).json")
  }

  var reasonValid: Bool {
    let length = reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    return (10...4000).contains(length)
  }

  var canSubmit: Bool {
    guard !busy, !journalInvalid, pending == nil, receipt == nil, reasonValid, let snapshot,
      snapshot.operation == nil else { return false }
    return snapshot.canStop
  }

  var canReconcile: Bool {
    guard !busy, !journalInvalid, let pending, let snapshot, receipt?.state != .settled else { return false }
    if let operation = snapshot.operation { return operation.request == pending }
    return !rejected
  }

  var canDiscardRejected: Bool {
    guard !busy, !journalInvalid, rejected, let pending, let snapshot else { return false }
    return snapshot.operation?.request.requestKey != pending.requestKey
  }

  func refresh(_ actions: StalledWorkerRecoveryActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; snapshot = nil
    defer { busy = false }
    do {
      if !journalLoaded {
        if FileManager.default.fileExists(atPath: journalURL.path) {
          do {
            let draft = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: journalURL))
            pending = draft.request; rejected = draft.rejected; reason = draft.request.reason
          } catch {
            journalInvalid = true
            throw DaemonError.badRequest("Saved stalled-worker-recovery request is unreadable. Retain it for inspection; no new request was sent.")
          }
        }
        journalLoaded = true
      }
      let value = try await actions.load(podId)
      guard bind(actions), !Task.isCancelled else { return }
      guard value.schemaVersion == 1, value.podId == podId, value.generation > 0,
        value.binding.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw DaemonError.badRequest("Recovery observation belongs to another or unsupported lifecycle.")
      }
      snapshot = value
      if let operation = value.operation {
        if let pending, operation.request != pending {
          throw DaemonError.badRequest("A different stalled-worker-recovery owns this pod. The saved request has not been replaced.")
        }
        if pending == nil {
          try persist(operation.request, rejected: false)
          pending = operation.request; reason = operation.request.reason
        }
        try accept(operation)
      }
    } catch {
      guard bind(actions), !Task.isCancelled else { return }
      if case DaemonError.notFound = error { self.error = "This daemon does not support stalled execution recovery. Update the daemon; no stop or fallback was performed." }
      else { self.error = error.localizedDescription }
    }
  }

  func submit(actions: StalledWorkerRecoveryActions) async {
    guard bind(actions), canSubmit, let snapshot else { return }
    let input = StalledWorkerRecoveryRequest(requestKey: UUID().uuidString,
      expectedGeneration: snapshot.generation, expectedBinding: snapshot.binding,
      reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
    do {
      try persist(input, rejected: false)
      pending = input; rejected = false
    } catch { self.error = "Could not preserve the request; nothing was sent: \(error.localizedDescription)"; return }
    await send(input, actions: actions)
  }

  func reconcile(_ actions: StalledWorkerRecoveryActions) async {
    guard bind(actions), canReconcile, let pending else { return }
    await send(pending, actions: actions)
  }

  /// Only a confirmed rejection AND fresh absence of that server intent permit a new decision.
  func discardRejected(_ actions: StalledWorkerRecoveryActions) async {
    guard bind(actions), canDiscardRejected else { return }
    do {
      try FileManager.default.removeItem(at: journalURL)
      pending = nil; rejected = false; receipt = nil
      await refresh(actions)
    } catch { self.error = error.localizedDescription }
  }

  private func send(_ input: StalledWorkerRecoveryRequest, actions: StalledWorkerRecoveryActions) async {
    busy = true; error = nil
    defer { busy = false }
    do {
      let value = try await actions.submit(podId, input)
      guard bind(actions), !Task.isCancelled else { return }
      try accept(value)
    }
    catch {
      guard bind(actions), !Task.isCancelled else { return }
      rejected = FollowUpFailure.isDefiniteRejection(error)
      // Never discard an intent on a 4xx: the daemon may already have recorded a hold.
      do { try persist(input, rejected: rejected) }
      catch { journalInvalid = true }
      snapshot = nil
      self.error = "\(error.localizedDescription) Result unconfirmed. Check status before reconciling the same saved request."
    }
  }

  private func accept(_ value: StalledWorkerRecoveryReceipt) throws {
    guard value.podId == podId, value.request == pending, value.resourcesRetained,
      value.state != .settled || value.settledAt != nil else {
      throw DaemonError.networkError("Unexpected stalled-worker-recovery receipt; no local completion was inferred.")
    }
    receipt = value
    if value.state == .settled, FileManager.default.fileExists(atPath: journalURL.path) {
      try FileManager.default.removeItem(at: journalURL)
    }
  }

  private func bind(_ actions: StalledWorkerRecoveryActions) -> Bool {
    guard actions.available, actions.scope == scope, actions.isCurrent() else {
      snapshot = nil
      error = "Connection changed or unavailable. Reopen stalled-worker-recovery on the current daemon."
      return false
    }
    return true
  }

  private func persist(_ request: StalledWorkerRecoveryRequest, rejected: Bool) throws {
    let folder = journalURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let exists = FileManager.default.fileExists(atPath: journalURL.path)
    if exists {
      let saved = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: journalURL))
      guard saved.request == request else {
        throw DaemonError.badRequest("Another saved stalled-worker-recovery request owns this pod. Reopen and inspect it; nothing was replaced.")
      }
    }
    try JSONEncoder().encode(Draft(request: request, rejected: rejected))
      .write(to: journalURL, options: exists ? .atomic : .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journalURL.path)
    let file = try FileHandle(forWritingTo: journalURL)
    defer { try? file.close() }
    try file.synchronize()
  }
}
