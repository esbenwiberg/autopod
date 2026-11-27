import AutopodClient
import Foundation
import Observation

public struct RetainedChecksActions: Sendable {
  let scope: String
  let draftScope: String
  let journalDirectory: URL?
  let available: Bool
  let isCurrent: @MainActor @Sendable () -> Bool
  let preview: @MainActor @Sendable (String) async throws -> RetainedChecksPreview
  let submit: @MainActor @Sendable (String, RetainedChecksDecision) async throws -> RetainedChecksOperation
  let observe: @MainActor @Sendable (String, RetainedChecksDecision) async throws -> RetainedChecksOperation

  public init(scope: String, draftScope: String, journalDirectory: URL? = nil, available: Bool = true,
    isCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
    preview: @escaping @MainActor @Sendable (String) async throws -> RetainedChecksPreview,
    submit: @escaping @MainActor @Sendable (String, RetainedChecksDecision) async throws -> RetainedChecksOperation,
    observe: @escaping @MainActor @Sendable (String, RetainedChecksDecision) async throws -> RetainedChecksOperation) {
    self.scope = scope; self.draftScope = draftScope; self.journalDirectory = journalDirectory
    self.available = available; self.isCurrent = isCurrent; self.preview = preview
    self.submit = submit; self.observe = observe
  }

  public static let unavailable = Self(scope: "unavailable", draftScope: "unavailable", available: false,
    preview: { _ in throw URLError(.unsupportedURL) }, submit: { _, _ in throw URLError(.unsupportedURL) },
    observe: { _, _ in throw URLError(.unsupportedURL) })
}

@MainActor @Observable final class RetainedChecksRecoveryModel {
  let podId: String
  private let scope: String
  private let journal: RepairContinuationJournal<RetainedChecksDecision>
  private var loaded = false
  private var revision = UUID()
  private(set) var invalidJournal = false
  private(set) var busy = false
  private(set) var preview: RetainedChecksPreview?
  private(set) var pending: RetainedChecksDecision?
  private(set) var operation: RetainedChecksOperation?
  private(set) var error: String?
  var reason = ""
  var confirmed = false

  init(podId: String, actions: RetainedChecksActions) {
    self.podId = podId
    scope = actions.scope
    journal = RepairContinuationJournal(scope: "retained-checks:\(actions.draftScope)",
      podId: podId, directory: actions.journalDirectory)
  }

  var needsObservation: Bool {
    invalidJournal || (pending != nil && operation?.checked == nil && operation?.blocked == nil)
  }
  var canSubmit: Bool { !busy && !invalidJournal && pending == nil && confirmed && decision(id: "preview") != nil }
  var outcome: String {
    if let blocked = operation?.blocked { return "Recovery blocked: \(blocked.code). The original remains retained." }
    if operation?.checked?.result.overall == "pass" { return "Fresh checks passed. Nothing was published; approval is separate." }
    if operation?.checked != nil { return "Fresh checks did not pass. Open Validation for the results." }
    if operation?.checking != nil { return "Fresh checks are running. No result yet." }
    if operation != nil { return "Request recorded. Check status again for the validation outcome." }
    return "Request outcome unconfirmed. Check the saved decision; do not send it again."
  }

  func invalidate() { revision = UUID(); preview = nil; confirmed = false }

  private func bound(_ actions: RetainedChecksActions) -> Bool {
    actions.available && actions.scope == scope && actions.isCurrent()
  }

  func refresh(_ actions: RetainedChecksActions, inspectSource: Bool) async {
    guard !busy, bound(actions) else { return }
    busy = true; error = nil; invalidate()
    let revision = self.revision
    defer { busy = false }
    do {
      if !loaded {
        do {
          pending = try journal.load()
          try pending?.validate(podId: podId)
          loaded = true
        } catch {
          invalidJournal = true
          throw error
        }
      }
      if let pending {
        let value = try await actions.observe(podId, pending)
        guard bound(actions), !Task.isCancelled else { return }
        try value.validate(podId: podId, decision: pending)
        operation = value
      } else if inspectSource {
        let value = try await actions.preview(podId)
        guard bound(actions), self.revision == revision, !Task.isCancelled else { return }
        try value.validate(podId: podId)
        preview = value
      }
    } catch {
      guard bound(actions), !Task.isCancelled else { return }
      self.error = error.localizedDescription
    }
  }

  private func decision(id: String) -> RetainedChecksDecision? {
    guard let preview else { return nil }
    let selection = RetainedChecksDecision(id: id, preview: preview, reason: reason)
    return (try? selection.validate(podId: podId)) != nil ? selection : nil
  }

  func submit(_ actions: RetainedChecksActions) async {
    guard canSubmit, bound(actions), let selection = decision(id: UUID().uuidString) else { return }
    busy = true; error = nil
    let revision = self.revision
    defer { busy = false }
    do {
      let fresh = try await actions.preview(podId)
      guard bound(actions), revision == self.revision, !Task.isCancelled else { return }
      guard fresh == selection.preview else {
        invalidate()
        self.error = "The saved source or failed result changed. Inspect it again; nothing was sent."
        return
      }
      do { try journal.save(selection); pending = selection }
      catch {
        invalidJournal = true
        self.error = "Could not save the recovery decision. Nothing was sent: \(error.localizedDescription)"
        return
      }
      let value = try await actions.submit(podId, selection)
      guard bound(actions), !Task.isCancelled else { return }
      try value.validate(podId: podId, decision: selection)
      operation = value
    } catch {
      guard bound(actions), !Task.isCancelled else { return }
      if pending == nil {
        invalidate()
        self.error = "Could not recheck the selected source. Nothing was sent: \(error.localizedDescription)"
      } else {
        self.error = "Outcome unconfirmed. Check the saved request instead of retrying: \(error.localizedDescription)"
      }
    }
  }
}
