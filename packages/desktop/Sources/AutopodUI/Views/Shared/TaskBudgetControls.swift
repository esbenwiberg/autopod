import AutopodClient
import SwiftUI

/// Shared by Work / Cost and repair handoffs. Budget admission is not retry permission.
struct TaskBudgetControls: View {
  @Environment(\.desktopRedesign) private var redesign
  let actions: TaskBudgetActions
  var continuationTitle: String? = nil
  var onContinue: (@MainActor () async -> Void)? = nil
  var onSaved: (@MainActor () async -> Void)? = nil
  @State var model: TaskBudgetModel
  @State private var confirmRemoval = false
  @State private var continueAfterSave = false

  init(
    podId: String, actions: TaskBudgetActions, model: TaskBudgetModel? = nil,
    continuationTitle: String? = nil, onContinue: (@MainActor () async -> Void)? = nil,
    onSaved: (@MainActor () async -> Void)? = nil
  ) {
    self.actions = actions
    self.continuationTitle = continuationTitle
    self.onContinue = onContinue
    self.onSaved = onSaved
    self._model = State(initialValue: model ?? TaskBudgetModel(podId: podId, scope: actions.scope))
  }

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label("Task token budget", systemImage: "gauge.with.dots.needle.67percent").font(.headline)
        Spacer()
        if model.busy { ProgressView().controlSize(.small) }
        Button("Refresh") { Task { await model.refresh(actions) } }
          .accessibilityIdentifier("task-budget-refresh").disabled(model.busy)
      }
      if let snapshot = model.snapshot {
        Text(
          "\(snapshot.totalRecordedTokens.formatted()) recorded tokens / \(snapshot.tokenBudget?.formatted() ?? "no limit")"
        )
        .monospacedDigit().accessibilityIdentifier("task-budget-usage")
        Text(
          "Shared across \(snapshot.podCount) pod(s), including linked repairs. Root: \(snapshot.rootPodId)"
        )
        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        Text(snapshot.budgetCheck?.reason ?? "Budget admission evidence unavailable.")
          .font(.callout).foregroundStyle(
            snapshot.budgetCheck?.status == "exhausted" ? .orange : .secondary)
        if snapshot.tokenBudget != nil {
          Text("New total token limit").font(.caption).foregroundStyle(.secondary)
          TextField("New total token limit", text: $model.limit)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel("New total token limit")
            .accessibilityIdentifier("task-budget-limit")
            .disabled(model.busy || model.removeLimit)
          Toggle("Remove token limit (unlimited)", isOn: $model.removeLimit)
            .accessibilityIdentifier("task-budget-unlimited").disabled(model.busy)
          if let validation = model.validation {
            Text(validation).font(.caption).foregroundStyle(.secondary)
          }
          ViewThatFits(in: .horizontal) {
            HStack { saveButtons }
            VStack(alignment: .leading) { saveButtons }
          }
        }
      }
      Text(
        "Cached input counts toward recorded tokens; this is not a dollar spending cap. Changes affect this task only, not its profile or frozen launch configuration. Retry, guidance, source and Goal checks still apply."
      )
      .font(.caption).foregroundStyle(.secondary)
      if let message = model.message { Text(message).font(.callout).textSelection(.enabled) }
      if let error = model.error {
        Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
      }
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .background(
      redesign ? DesktopTheme.surface : Color(nsColor: .controlBackgroundColor),
      in: RoundedRectangle(cornerRadius: 10)
    )
    .task { await model.refresh(actions) }
    .confirmationDialog("Remove this task’s token limit?", isPresented: $confirmRemoval) {
      Button("Remove limit", role: .destructive) { save(continuing: continueAfterSave) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "This removes the token cap across the entire task, including linked repair pods. Other execution checks remain in force.\(continueAfterSave ? " The selected recovery will also be requested after the budget is saved." : " No execution will be started.")"
      )
    }
  }

  @ViewBuilder private var saveButtons: some View {
    Button("Save budget") { requestSave(continuing: false) }
      .accessibilityIdentifier("task-budget-save").disabled(!model.canSave)
    if let continuationTitle, onContinue != nil {
      Button("Save budget and \(continuationTitle.lowercased())") { requestSave(continuing: true) }
        .accessibilityIdentifier("task-budget-save-continue").disabled(!model.canSave)
    }
  }

  private func requestSave(continuing: Bool) {
    if model.removeLimit {
      continueAfterSave = continuing
      confirmRemoval = true
    } else {
      save(continuing: continuing)
    }
  }

  private func save(continuing: Bool) {
    Task {
      guard await model.save(actions) else { return }
      // Request admission through the existing repair model, never bypass it.
      if continuing { await onContinue?() }
      await onSaved?()
    }
  }
}
