import AutopodClient
import SwiftUI

/// Compact task token limit shown beneath Work → Cost metrics.
///
/// Reuses `TaskBudgetModel` and its raise-or-remove rules; the full editor (and the
/// repair hand-off) stays under Work → Task → Task budget. Lowering or adding a
/// limit is intentionally not offered here.
struct TaskTokenLimitCostSection: View {
  let pod: Pod
  let actions: TaskBudgetActions
  @State var model: TaskBudgetModel
  @State private var editing = false
  @State private var confirmRemoval = false

  init(pod: Pod, actions: TaskBudgetActions, model: TaskBudgetModel? = nil) {
    self.pod = pod
    self.actions = actions
    self._model = State(initialValue: model ?? TaskBudgetModel(podId: pod.id, scope: actions.scope))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      if let snapshot = model.snapshot {
        usage(snapshot)
        if pod.isBudgetPaused && !model.pauseApproved { pauseApproval }
        if snapshot.tokenBudget != nil {
          if editing { editor } else { limitActions }
        }
      } else if model.error != nil {
        unavailable
      } else {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Loading task token limit…").font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("task-token-limit-loading")
      }
      footnote
      feedback
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(Color(nsColor: .separatorColor).opacity(0.18), lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("task-token-limit")
    .task { await model.refresh(actions) }
    .confirmationDialog("Remove this task’s token limit?", isPresented: $confirmRemoval) {
      Button("Remove limit", role: .destructive) { removeLimit() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "This removes the token cap across the entire task, including linked repair pods. Other execution checks remain in force. No execution will be started."
      )
    }
  }

  // MARK: - Sections

  private var header: some View {
    HStack(spacing: 8) {
      Image(systemName: "gauge.with.dots.needle.67percent").foregroundStyle(.blue)
      Text("Task token limit")
        .font(.system(.headline).weight(.semibold))
        .lineLimit(1)
      Spacer(minLength: 8)
      if model.busy { ProgressView().controlSize(.small) }
      Button {
        Task { await model.refresh(actions) }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.borderless)
      .help("Refresh the task token limit")
      .accessibilityLabel("Refresh task token limit")
      .accessibilityIdentifier("task-token-limit-refresh")
      .disabled(model.busy)
    }
  }

  private func usage(_ snapshot: TaskExecutionSummary) -> some View {
    let used = snapshot.tokensCountedForBudget
    let exhausted = snapshot.budgetCheck?.status == "exhausted"
    return VStack(alignment: .leading, spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 16) {
          usedMetric(used)
          Spacer(minLength: 8)
          limitMetric(snapshot.tokenBudget, alignment: .trailing)
        }
        VStack(alignment: .leading, spacing: 8) {
          usedMetric(used)
          limitMetric(snapshot.tokenBudget, alignment: .leading)
        }
      }
      if let limit = snapshot.tokenBudget, limit > 0 {
        usageBar(fraction: min(Double(used) / Double(limit), 1), exhausted: exhausted)
      }
      if let detail = snapshot.budgetUsageDetail {
        Text(detail)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .monospacedDigit()
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("task-token-limit-usage-detail")
      }
      if let check = snapshot.budgetCheck {
        Text(check.reason)
          .font(.caption)
          .foregroundStyle(exhausted ? .orange : .secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func usageBar(fraction: Double, exhausted: Bool) -> some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.secondary.opacity(0.15))
        Capsule()
          .fill(exhausted ? Color.orange : Color.blue)
          .frame(width: max(fraction * geo.size.width, fraction > 0 ? 6 : 0))
      }
    }
    .frame(height: 6)
    .accessibilityElement()
    .accessibilityLabel("Budget-counted usage against the task token limit")
    .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
  }

  private func usedMetric(_ used: Int) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("Budget-counted").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
      Text(used.formatted())
        .font(.system(size: 16, weight: .semibold, design: .monospaced))
        .monospacedDigit()
        .lineLimit(1)
        .accessibilityIdentifier("task-token-limit-used")
    }
  }

  private func limitMetric(_ limit: Int?, alignment: HorizontalAlignment) -> some View {
    VStack(alignment: alignment, spacing: 2) {
      Text("Limit").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
      Text(limit?.formatted() ?? "No limit")
        .font(.system(size: 16, weight: .semibold, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(limit == nil ? .secondary : .primary)
        .lineLimit(1)
        .accessibilityIdentifier("task-token-limit-value")
    }
  }

  private var unavailable: some View {
    VStack(alignment: .leading, spacing: 4) {
      Label("Task token limit unavailable", systemImage: "exclamationmark.triangle")
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.orange)
        .accessibilityIdentifier("task-token-limit-unavailable")
      Text("The current limit could not be loaded. This does not mean the task has no limit.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var pauseApproval: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Paused on its token budget", systemImage: "pause.circle")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.orange)
      Text(
        "The worker finished its turn. Approving allows one budget extension and continues to validation in the background. It does not change the limit."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Button("Approve budget & continue") {
        Task { _ = await model.approvePause(actions) }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .disabled(model.busy)
      .accessibilityIdentifier("task-token-limit-approve-pause")
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }

  private var limitActions: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) {
        increaseButton
        removeButton
        Spacer(minLength: 0)
      }
      VStack(alignment: .leading, spacing: 6) {
        increaseButton
        removeButton
      }
    }
  }

  private var increaseButton: some View {
    Button {
      model.limit = ""
      editing = true
    } label: {
      Label("Increase limit", systemImage: "arrow.up.circle")
    }
    .controlSize(.small)
    .disabled(model.busy)
    .accessibilityIdentifier("task-token-limit-increase")
  }

  private var removeButton: some View {
    Button(role: .destructive) {
      confirmRemoval = true
    } label: {
      Label("Remove limit", systemImage: "xmark.circle")
    }
    .controlSize(.small)
    .disabled(model.busy || model.requiresRefresh)
    .accessibilityIdentifier("task-token-limit-remove")
  }

  private var editor: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("New total token limit").font(.caption).foregroundStyle(.secondary)
      TextField("New total token limit", text: $model.limit)
        .textFieldStyle(.roundedBorder)
        .monospacedDigit()
        .accessibilityLabel("New total token limit")
        .accessibilityIdentifier("task-token-limit-field")
        .disabled(model.busy)
        .onSubmit { if model.canSave { saveIncrease() } }
      if !model.limit.isEmpty, let validation = model.validation {
        Text(validation)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 8) {
        Button("Save limit") { saveIncrease() }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(!model.canSave)
          .accessibilityIdentifier("task-token-limit-save")
        Button("Cancel") {
          editing = false
          model.limit = ""
        }
        .controlSize(.small)
        .disabled(model.busy)
        .accessibilityIdentifier("task-token-limit-cancel")
      }
    }
  }

  private var footnote: some View {
    let pods = model.snapshot.map { " (\($0.podCount) pod\($0.podCount == 1 ? "" : "s"))" } ?? ""
    return Text(
      "Shared across this task and its linked repair pods\(pods). Cache reads count at 0.1×. This is a token limit, not a dollar cap. Changing it does not restart execution or change profile defaults."
    )
    .font(.caption)
    .foregroundStyle(.secondary)
    .fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder private var feedback: some View {
    if let message = model.message {
      Text(message)
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .accessibilityIdentifier("task-token-limit-message")
    }
    if let error = model.error {
      VStack(alignment: .leading, spacing: 6) {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .accessibilityIdentifier("task-token-limit-error")
        Button("Refresh budget") { Task { await model.refresh(actions) } }
          .controlSize(.small)
          .disabled(model.busy)
          .accessibilityIdentifier("task-token-limit-error-refresh")
      }
    }
  }

  // MARK: - Actions

  private func saveIncrease() {
    model.removeLimit = false
    Task {
      if await model.save(actions) {
        editing = false
        model.limit = ""
      }
    }
  }

  private func removeLimit() {
    // Set only for this confirmed request so a cancelled dialog cannot leave the
    // shared model in removal mode.
    model.removeLimit = true
    Task {
      if await model.save(actions) { editing = false }
      model.removeLimit = false
    }
  }
}
