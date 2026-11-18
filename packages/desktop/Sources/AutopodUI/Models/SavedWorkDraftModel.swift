import AutopodClient
import Foundation
import Observation

public struct SavedWorkDraftActions: Sendable {
  public var scope: String
  public var available = true
  public var isCurrent: @MainActor @Sendable () -> Bool = { true }
  public var inspect: @MainActor @Sendable (String) async throws -> SavedWorkDraftPreview
  public var prepare: @MainActor @Sendable (String, SavedWorkDraftPrepare) async throws -> SavedWorkDraftOperation
  public var confirm: @MainActor @Sendable (String, SavedWorkDraftConfirm) async throws -> SavedWorkDraftOperation
  public var observe: @MainActor @Sendable (String, String) async throws -> SavedWorkDraftOperation
  public var cancel: @MainActor @Sendable (String, SavedWorkDraftCancel) async throws -> SavedWorkDraftOperation = { _, _ in throw URLError(.unsupportedURL) }
  public var cancelPreparation: @MainActor @Sendable (String, SavedWorkDraftPrepare) async throws -> SavedWorkDraftPreparationCancellation = { _, _ in throw URLError(.unsupportedURL) }
  public init(scope: String, available: Bool = true, isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    inspect: @escaping @MainActor @Sendable (String) async throws -> SavedWorkDraftPreview,
    prepare: @escaping @MainActor @Sendable (String, SavedWorkDraftPrepare) async throws -> SavedWorkDraftOperation,
    confirm: @escaping @MainActor @Sendable (String, SavedWorkDraftConfirm) async throws -> SavedWorkDraftOperation,
    observe: @escaping @MainActor @Sendable (String, String) async throws -> SavedWorkDraftOperation) {
    self.scope = scope; self.available = available; self.isCurrent = isCurrent
    self.inspect = inspect; self.prepare = prepare; self.confirm = confirm; self.observe = observe
  }
  public static let unavailable = SavedWorkDraftActions(scope: "unavailable", available: false,
    inspect: { _ in throw URLError(.unsupportedURL) }, prepare: { _, _ in throw URLError(.unsupportedURL) },
    confirm: { _, _ in throw URLError(.unsupportedURL) }, observe: { _, _ in throw URLError(.unsupportedURL) })
}

@MainActor @Observable final class SavedWorkDraftModel {
  let podId: String
  let scope: String
  private let preparation: RepairContinuationJournal<SavedWorkDraftPrepare>
  private let confirmation: RepairContinuationJournal<SavedWorkDraftConfirm>
  private let cancellation: RepairContinuationJournal<SavedWorkDraftCancel>
  private(set) var preview: SavedWorkDraftPreview?
  private(set) var operation: SavedWorkDraftOperation?
  private(set) var pending: SavedWorkDraftPrepare?
  private(set) var confirmationSent = false
  private(set) var cancellationSent = false
  private var observedPushed = false
  private(set) var busy = false
  private(set) var error: String?
  private(set) var invalidJournal = false
  var selectedSource = ""
  var acknowledgeDraftOnly = false
  init(podId: String, scope: String, directory: URL? = nil) {
    self.podId = podId; self.scope = scope
    preparation = .init(scope: scope + "\0saved-work-draft-prepare", podId: podId, directory: directory)
    confirmation = .init(scope: scope + "\0saved-work-draft-confirm", podId: podId, directory: directory)
    cancellation = .init(scope: scope + "\0saved-work-draft-cancel", podId: podId, directory: directory)
    do { pending = try preparation.load(); confirmationSent = try confirmation.load() != nil; cancellationSent = try cancellation.load() != nil }
    catch { invalidJournal = true; self.error = error.localizedDescription }
  }
  var canPrepare: Bool { !busy && !invalidJournal && pending == nil && (operation == nil || operation?.state == "cancelled") && preview?.sources.contains(where: { $0.id == selectedSource }) == true }
  var canCancel: Bool { !busy && !invalidJournal && !cancellationSent && ["preparing", "prepared"].contains(operation?.state ?? "") }
  var canCancelPendingPreparation: Bool { !busy && !invalidJournal && pending != nil && operation == nil }
  var canConfirm: Bool {
    !busy && !invalidJournal && !cancellationSent && acknowledgeDraftOnly &&
      ((!confirmationSent && operation?.state == "prepared") || (observedPushed && operation?.state == "pushed"))
  }
  var needsObservation: Bool { pending != nil && (operation == nil || ["preparing", "push-uncertain", "create-uncertain"].contains(operation?.state ?? "")) }
  private func bound(_ actions: SavedWorkDraftActions) -> Bool { actions.available && actions.scope == scope && actions.isCurrent() }
  func refresh(_ actions: SavedWorkDraftActions) async {
    guard !busy, bound(actions) else { return }
    busy = true; defer { busy = false }
    do {
      if let pending {
        let op = try await actions.observe(podId, pending.requestId)
        guard bound(actions), op.podId == podId, op.requestId == pending.requestId,
          op.previewBinding == pending.expectedBinding, op.source.id == pending.sourceId else { throw URLError(.badServerResponse) }
        operation = op
        observedPushed = op.state == "pushed"
      } else {
        let value = try await actions.inspect(podId)
        guard bound(actions), value.podId == podId else { throw URLError(.badServerResponse) }
        preview = value; operation = value.operation
        observedPushed = value.operation?.state == "pushed"
      }
      error = nil
    } catch {
      if let daemon = error as? DaemonError, case .notFound = daemon {
        self.error = "Saved-work draft API or operation unavailable. Refresh the task and connection; a supporting daemon is required. No request was resubmitted."
      } else { self.error = "\(error.localizedDescription) Observe this same operation; no request was resubmitted." }
    }
  }
  func prepare(_ actions: SavedWorkDraftActions) async {
    guard canPrepare, bound(actions), let preview else { return }
    let request = SavedWorkDraftPrepare(requestId: UUID().uuidString, expectedBinding: preview.binding, sourceId: selectedSource)
    do { try preparation.save(request); pending = request }
    catch { invalidJournal = true; self.error = error.localizedDescription; return }
    busy = true; defer { busy = false }
    do {
      let op = try await actions.prepare(podId, request)
      guard bound(actions), op.podId == podId, op.requestId == request.requestId,
        op.previewBinding == request.expectedBinding, op.source.id == request.sourceId else { throw URLError(.badServerResponse) }
      operation = op
    } catch { self.error = "\(error.localizedDescription) Preparation outcome unconfirmed. Observe; do not resubmit." }
  }
  func confirm(_ actions: SavedWorkDraftActions) async {
    guard canConfirm, bound(actions), let operation else { return }
    let request = SavedWorkDraftConfirm(requestId: operation.requestId, expectedBinding: operation.confirmationBinding)
    do { try confirmation.save(request); confirmationSent = true }
    catch { invalidJournal = true; self.error = error.localizedDescription; return }
    busy = true; defer { busy = false }
    observedPushed = false
    do {
      let op = try await actions.confirm(podId, request)
      guard bound(actions), op.id == operation.id, op.confirmationBinding == request.expectedBinding else { throw URLError(.badServerResponse) }
      self.operation = op
    } catch { self.error = "\(error.localizedDescription) Publication outcome unconfirmed. Observe the same operation; confirmation will not be resubmitted." }
  }
  func cancel(_ actions: SavedWorkDraftActions) async {
    guard canCancel, bound(actions), let operation else { return }
    let request = SavedWorkDraftCancel(requestId: operation.requestId, expectedBinding: operation.confirmationBinding)
    do { try cancellation.save(request); cancellationSent = true }
    catch { invalidJournal = true; self.error = error.localizedDescription; return }
    busy = true; defer { busy = false }
    do {
      let op = try await actions.cancel(podId, request)
      guard bound(actions), op.id == operation.id, op.confirmationBinding == request.expectedBinding, op.state == "cancelled" else { throw URLError(.badServerResponse) }
      self.operation = op
    } catch { self.error = "\(error.localizedDescription) Observe the same operation; no source or resource cleanup was requested." }
  }
  func reviewAgain(_ actions: SavedWorkDraftActions) async {
    guard !busy, bound(actions), operation?.state == "cancelled" else { return }
    do {
      for url in [preparation.url, confirmation.url, cancellation.url] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      pending = nil; confirmationSent = false; cancellationSent = false; observedPushed = false
      operation = nil; selectedSource = ""; acknowledgeDraftOnly = false
      await refresh(actions)
    } catch { invalidJournal = true; self.error = error.localizedDescription }
  }
  func cancelPendingPreparation(_ actions: SavedWorkDraftActions) async {
    guard canCancelPendingPreparation, bound(actions), let pending else { return }
    busy = true; defer { busy = false }
    do {
      // A negative lookup is not absence proof. This explicit daemon write
      // revokes this request durably and fences any delayed preparation admission.
      let receipt = try await actions.cancelPreparation(podId, pending)
      guard bound(actions), receipt.podId == podId, receipt.requestId == pending.requestId,
        receipt.expectedBinding == pending.expectedBinding, receipt.sourceId == pending.sourceId,
        receipt.state == "cancelled-before-publication" else { throw URLError(.badServerResponse) }
      for url in [preparation.url, confirmation.url, cancellation.url] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      self.pending = nil; confirmationSent = false; cancellationSent = false
      operation = nil; preview = nil; selectedSource = ""; acknowledgeDraftOnly = false
      busy = false
      await refresh(actions)
    } catch { self.error = "\(error.localizedDescription) Pending request retained. No preparation was resubmitted or source/resource deleted." }
  }
}
