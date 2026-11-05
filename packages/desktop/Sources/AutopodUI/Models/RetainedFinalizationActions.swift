import AutopodClient
import CryptoKit
import Foundation
import Observation

public struct RetainedFinalizationActions: Sendable {
  public let scope: String
  public let draftScope: String
  public let journalDirectory: URL?
  public let available: Bool
  public let load: @MainActor @Sendable (String) async throws -> RetainedFinalizationView
  public let submit: @MainActor @Sendable (String, RetainedFinalizationRequest) async throws -> RetainedFinalizationReceipt

  public init(scope: String, draftScope: String, journalDirectory: URL? = nil, available: Bool = true,
              load: @escaping @MainActor @Sendable (String) async throws -> RetainedFinalizationView,
              submit: @escaping @MainActor @Sendable (String, RetainedFinalizationRequest) async throws -> RetainedFinalizationReceipt) {
    self.scope = scope; self.draftScope = draftScope; self.journalDirectory = journalDirectory
    self.available = available; self.load = load; self.submit = submit
  }

  public static let unavailable = Self(scope: "unavailable", draftScope: "unavailable", available: false,
    load: { _ in throw URLError(.unsupportedURL) }, submit: { _, _ in throw URLError(.unsupportedURL) })
}

/// An uncertain request survives sheet/app closure. Inspection never resubmits it.
@Observable @MainActor internal final class RetainedFinalizationModel {
  let podId: String
  private let scope: String
  private let journalURL: URL
  private var journalLoaded = false
  private var journalInvalid = false
  private var rejected = false
  var reason = ""
  private(set) var snapshot: RetainedFinalizationView?
  private(set) var pending: RetainedFinalizationRequest?
  private(set) var receipt: RetainedFinalizationReceipt?
  private(set) var busy = false
  private(set) var error: String?

  private struct Draft: Codable {
    let request: RetainedFinalizationRequest
    let rejected: Bool
  }

  init(podId: String, actions: RetainedFinalizationActions) {
    self.podId = podId; self.scope = actions.scope
    let identity = Data("\(actions.draftScope.utf8.count):\(actions.draftScope)\(podId)".utf8)
    let key = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    let folder = actions.journalDirectory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/retained-finalization", isDirectory: true)
    self.journalURL = folder.appendingPathComponent("\(key).json")
  }

  var reasonValid: Bool {
    let length = reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    return (10...4000).contains(length)
  }

  func canSubmit(_ mode: RetainedFinalizationMode) -> Bool {
    guard !busy, !journalInvalid, pending == nil, receipt == nil, reasonValid, let snapshot,
      snapshot.operation == nil else { return false }
    return mode == .stopRetain ? snapshot.canStop : snapshot.canCompleteMerged
  }

  var canReconcile: Bool {
    guard !busy, !journalInvalid, let pending, let snapshot, receipt?.state != .finalized else { return false }
    if let operation = snapshot.operation { return operation.request == pending }
    return !rejected
  }

  var canDiscardRejected: Bool {
    guard !busy, !journalInvalid, rejected, let pending, let snapshot else { return false }
    return snapshot.operation?.request.requestKey != pending.requestKey
  }

  func refresh(_ actions: RetainedFinalizationActions) async {
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
            throw DaemonError.badRequest("Saved finalization request is unreadable. Retain it for inspection; no new request was sent.")
          }
        }
        journalLoaded = true
      }
      let value = try await actions.load(podId)
      guard value.podId == podId, value.generation > 0,
        value.binding.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw DaemonError.badRequest("Finalization observation belongs to another or unsupported lifecycle.")
      }
      snapshot = value
      if let operation = value.operation {
        if let pending, operation.request != pending {
          throw DaemonError.badRequest("A different finalization owns this pod. The saved request has not been replaced.")
        }
        if pending == nil {
          try persist(operation.request, rejected: false)
          pending = operation.request; reason = operation.request.reason
        }
        try accept(operation)
      }
    } catch { self.error = error.localizedDescription }
  }

  func submit(_ mode: RetainedFinalizationMode, actions: RetainedFinalizationActions) async {
    guard bind(actions), canSubmit(mode), let snapshot else { return }
    let input = RetainedFinalizationRequest(requestKey: UUID().uuidString,
      expectedGeneration: snapshot.generation, expectedBinding: snapshot.binding, mode: mode,
      reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
    do {
      try persist(input, rejected: false)
      pending = input; rejected = false
    } catch { self.error = "Could not preserve the request; nothing was sent: \(error.localizedDescription)"; return }
    await send(input, actions: actions)
  }

  func reconcile(_ actions: RetainedFinalizationActions) async {
    guard bind(actions), canReconcile, let pending else { return }
    await send(pending, actions: actions)
  }

  /// Only a confirmed rejection AND fresh absence of that server intent permit a new decision.
  func discardRejected(_ actions: RetainedFinalizationActions) async {
    guard bind(actions), canDiscardRejected else { return }
    do {
      try FileManager.default.removeItem(at: journalURL)
      pending = nil; rejected = false; receipt = nil
      await refresh(actions)
    } catch { self.error = error.localizedDescription }
  }

  private func send(_ input: RetainedFinalizationRequest, actions: RetainedFinalizationActions) async {
    busy = true; error = nil
    defer { busy = false }
    do { try accept(try await actions.submit(podId, input)) }
    catch {
      rejected = FollowUpFailure.isDefiniteRejection(error)
      // Never discard an intent on a 4xx: the daemon may already have recorded a hold.
      do { try persist(input, rejected: rejected) }
      catch { journalInvalid = true }
      snapshot = nil
      self.error = "\(error.localizedDescription) Result unconfirmed. Check status before reconciling the same saved request."
    }
  }

  private func accept(_ value: RetainedFinalizationReceipt) throws {
    guard value.podId == podId, value.request == pending, value.resourcesRetained,
      value.state != .finalized || value.finalizedAt != nil else {
      throw DaemonError.networkError("Unexpected finalization receipt; no local completion was inferred.")
    }
    receipt = value
    if value.state == .finalized, FileManager.default.fileExists(atPath: journalURL.path) {
      try FileManager.default.removeItem(at: journalURL)
    }
  }

  private func bind(_ actions: RetainedFinalizationActions) -> Bool {
    guard actions.available, actions.scope == scope else {
      snapshot = nil
      error = "Connection changed or unavailable. Reopen finalization on the current daemon."
      return false
    }
    return true
  }

  private func persist(_ request: RetainedFinalizationRequest, rejected: Bool) throws {
    let folder = journalURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let exists = FileManager.default.fileExists(atPath: journalURL.path)
    if exists {
      let saved = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: journalURL))
      guard saved.request == request else {
        throw DaemonError.badRequest("Another saved finalization request owns this pod. Reopen and inspect it; nothing was replaced.")
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
