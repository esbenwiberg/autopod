import SwiftUI

struct DecisionReplyContext: Equatable, Hashable {
  let handlerID: UUID
  let podID: String
  let decisionID: String?
  var awaitingInput = true
}

/// Reference-owned mounted identity; an old Task's captured View is not live state.
@Observable @MainActor
final class DecisionReplySurface {
  private(set) var context: DecisionReplyContext?
  private(set) var lease: UUID?
  private var preparationID: UUID?
  var loading = false
  var error: String?

  func mount(_ context: DecisionReplyContext) {
    if self.context != context { loading = false; error = nil; preparationID = nil }
    self.context = context
    lease = UUID()
  }
  func unmount() { context = nil; lease = nil; preparationID = nil }

  func canDismiss(_ captured: DecisionReplyContext, lease: UUID?, actions: DecisionReplyActions, record: UUID?) -> Bool {
    guard let lease, self.lease == lease, context == captured, let decision = captured.decisionID, let record else { return false }
    return actions.isCurrent(captured.podID, decision, record)
  }

  /// Capture the mount lease synchronously, before this work can be queued.
  @discardableResult
  func prepareTask(_ context: DecisionReplyContext, actions: DecisionReplyActions) -> Task<Void, Never> {
    let capturedLease = lease
    return Task { await prepare(context, lease: capturedLease, actions: actions) }
  }

  private func prepare(_ context: DecisionReplyContext, lease: UUID?, actions: DecisionReplyActions) async {
    guard let lease, self.lease == lease, self.context == context, !Task.isCancelled,
          context.awaitingInput, context.decisionID == nil else { return }
    let operation = UUID()
    preparationID = operation
    loading = true
    let result = await actions.prepare(context.podID)
    guard self.lease == lease, self.context == context, preparationID == operation, !Task.isCancelled else { return }
    loading = false
    if case .unavailable(let message) = result { error = message }
  }
}

struct DecisionReplyNotice: View {
  let snapshot: DecisionReplySnapshot
  let surface: DecisionReplySurface
  let unknown: Bool
  var retry: () -> Void

  var body: some View {
    if unknown {
      if surface.loading {
        Label("Loading current question…", systemImage: "arrow.triangle.2.circlepath")
          .font(.caption).foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Text(surface.error ?? "Load the current question before replying.")
            .font(.caption).foregroundStyle(.secondary)
          Button("Refresh question", action: retry).controlSize(.small)
            .accessibilityIdentifier("decision-refresh-question")
        }
      }
    } else if let notice = snapshot.notice {
      Text(notice)
        .font(.caption)
        .foregroundStyle(snapshot.acknowledged ? Color.secondary : Color.orange)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("decision-reply-notice")
    }
  }
}

/// Immutable identity of controls already rendered on screen. Live model reads
/// may update the next render, but must never retarget an existing callback.
struct DecisionReplyInteraction {
  let context: DecisionReplyContext
  let actions: DecisionReplyActions

  @MainActor var snapshot: DecisionReplySnapshot {
    actions.snapshot(context.podID, context.decisionID)
  }
  @MainActor func edit(_ text: String) {
    if let decision = context.decisionID { actions.edit(context.podID, decision, text) }
  }
  @MainActor func discard() {
    if let decision = context.decisionID { actions.discard(context.podID, decision) }
  }
  @MainActor func submit(selected: String? = nil) -> Task<DecisionReplyOutcome, Never> {
    guard let decision = context.decisionID, snapshot.canSubmit else { return Task { .notAdmitted } }
    if let selected { edit(selected) }
    return actions.submit(context.podID, decision)
  }
}
