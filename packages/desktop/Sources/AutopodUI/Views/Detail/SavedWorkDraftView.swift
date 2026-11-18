import AutopodClient
import SwiftUI

struct SavedWorkDraftView: View {
  let actions: SavedWorkDraftActions
  @State private var model: SavedWorkDraftModel
  @Environment(\.dismiss) private var dismiss
  init(podId: String, actions: SavedWorkDraftActions) {
    self.actions = actions
    _model = State(initialValue: SavedWorkDraftModel(podId: podId, scope: actions.scope))
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Create draft PR from saved work…").font(.title2)
      Text("Task: \(model.podId)").textSelection(.enabled)
      Text("Draft only. Original retained. Failed status, checks and retry budgets stay unchanged. This does not approve or complete the task.")
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let preview = model.preview {
            Text("Repository: \(preview.repository)\nTarget: \(preview.baseBranch)")
            ForEach(preview.blockers, id: \.self) { Text($0).foregroundStyle(.orange) }
            Picker("Saved source", selection: $model.selectedSource) {
              Text("Select exact saved source").tag("")
              ForEach(preview.sources) { source in Text("\(source.id) — \(source.freshness)").tag(source.id) }
            }.disabled(model.pending != nil || (model.operation != nil && model.operation?.state != "cancelled"))
            if let source = preview.sources.first(where: { $0.id == model.selectedSource }) { sourceDetails(source) }
            Text(preview.checks).font(.caption).textSelection(.enabled)
          }
          if let op = model.operation {
            Text("Operation: \(op.id)\nState: \(op.state)\nRepository: \(op.repository)\nTarget: \(op.baseBranch)\nNew branch: \(op.branch)").textSelection(.enabled)
            sourceDetails(op.source)
            if let message = op.message { Text(message).foregroundStyle(.orange) }
            Text(op.checks).font(.caption).textSelection(.enabled)
            if let url = op.safeDraftURL { Link("View saved-work draft (review only)", destination: url) }
            if (op.state == "prepared" && !model.confirmationSent) || op.state == "pushed" {
              Toggle("Publish these exact saved bytes as a draft only; retain the original", isOn: $model.acknowledgeDraftOnly)
              Button("Create draft only — original retained") { Task { await model.confirm(actions) } }
                .disabled(!model.canConfirm).accessibilityIdentifier("saved-work-draft-confirm")
            }
            if op.state == "pushed" { Text("Branch publication observed. A fresh explicit confirmation can continue this same operation to draft creation. Uncertain create requests are never replayed.") }
            if ["preparing", "prepared"].contains(op.state) {
              Button("Cancel draft preparation — retain all resources") { Task { await model.cancel(actions) } }.disabled(!model.canCancel)
            }
            if op.state == "cancelled" {
              Button("Review another saved source…") { Task { await model.reviewAgain(actions) } }.disabled(model.busy)
            }
          }
          if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
          if model.needsObservation { Text("Outcome unsettled. Observe the same operation; no automatic resubmission.") }
          if model.canCancelPendingPreparation {
            Text("If preparation cannot be observed, explicitly revoke this exact request on the daemon. A durable cancellation receipt prevents delayed admission; a negative lookup alone never clears the saved request.")
            Button("Cancel pending preparation — prevent delayed admission") { Task { await model.cancelPendingPreparation(actions) } }
          }
        }
      }
      HStack {
        Button("Observe / refresh") { Task { await model.refresh(actions) } }.disabled(model.busy || !actions.available)
        Button("Prepare selected saved work…") { Task { await model.prepare(actions) } }.disabled(!model.canPrepare)
          .accessibilityIdentifier("saved-work-draft-prepare")
        Spacer()
        Button("Close") { dismiss() }
      }
      if !actions.available { Text("Saved-work draft API is unavailable on this connection. Update or reconnect to a supporting daemon.") }
    }.padding().frame(minWidth: 650, minHeight: 500)
      .task { await model.refresh(actions) }
  }
  private func sourceDetails(_ source: SavedWorkSource) -> some View {
    Text("Commit: \(source.commit)\nTree: \(source.tree)\nCapture: \(source.capturedAt ?? "unknown") (\(source.freshness))\n\(source.exclusions)")
      .font(.caption).textSelection(.enabled)
  }
}
