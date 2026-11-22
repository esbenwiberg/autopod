import AutopodClient
import SwiftUI

struct RetainedCleanupView: View {
  let actions: RetainedCleanupActions
  let model: RetainedCleanupModel

  var body: some View {
    @Bindable var input = model
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        RecoverySectionTitle(title: "Delete & free resources",
          subtitle: "Delete only the listed retained Docker and host resources. This never stops a pod or completes the task.")
        Spacer()
        Button(model.requestId == nil ? "Check eligibility" : "Observe request") {
          Task { await model.refresh(actions) }
        }.disabled(model.busy || !actions.available)
          .accessibilityIdentifier("retained-cleanup-observe")
      }
      if model.busy { ProgressView("Checking exact cleanup state…").controlSize(.small) }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Pod: \(model.podId)").font(.caption.monospaced()).textSelection(.enabled)
          if let error = model.error { RecoveryNotice(title: "Cleanup needs attention", message: error) }
          if let key = model.requestId {
            Text("Exact request: \(key)").font(.callout.monospaced()).textSelection(.enabled)
            if let pending = model.pending { Text("Reason: \(pending.reason)").font(.callout).textSelection(.enabled) }
          }
          Text(outcome).font(.headline).accessibilityIdentifier("retained-cleanup-outcome")
          if !model.blockers.isEmpty {
            ForEach(Array(model.blockers.enumerated()), id: \.offset) { _, blocker in
              VStack(alignment: .leading, spacing: 4) {
                Text(blocker.message)
                Text([blocker.code, blocker.resourceId].compactMap { $0 }.joined(separator: " · "))
                  .font(.caption.monospaced()).foregroundStyle(RecoveryPalette.secondary)
              }.textSelection(.enabled)
            }
          }
          if let plan = model.plan {
            consequences(plan)
            if model.requestId == nil {
              Toggle("I accept permanent loss of the listed resources and unpublished work.", isOn: $input.acknowledgesLoss)
                .accessibilityIdentifier("retained-cleanup-acknowledge")
              TextField("Reason (10–4000 characters)", text: $input.reason, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...4).accessibilityIdentifier("retained-cleanup-reason")
              Button("Delete these exact resources", role: .destructive) {
                Task { await model.apply(reviewed: plan, actions: actions) }
              }.disabled(!model.canSubmit || !actions.isCurrent())
                .accessibilityIdentifier("retained-cleanup-apply")
            }
          }
          if model.requestId != nil && model.receipt?.state != .deleted {
            if model.pending != nil {
              Text("Observation is read-only. Reconcile explicitly sends the same saved request as the original operator; it never creates a new ID.")
                .font(.callout)
              Button("Reconcile saved request", role: .destructive) {
                Task { await model.reconcile(actions) }
              }.disabled(!model.canReconcile || !actions.isCurrent())
                .accessibilityIdentifier("retained-cleanup-reconcile")
            } else {
              Text("Observe here. Use the original operator and saved request to reconcile from the client that submitted it.")
                .font(.callout)
            }
          }
          if model.plan == nil && model.requestId == nil {
            Text("If this run is older or the daemon cannot prove custody or host identity, keep its resources. Stop and retain, where supported, does not free storage.")
              .font(.callout).foregroundStyle(RecoveryPalette.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .task { await model.refresh(actions) }
  }

  private var outcome: String {
    if let receipt = model.receipt {
      switch receipt.state {
      case .pending: return "Requested — pending"
      case .partial: return "Partial — cleanup remains owned by this request"
      case .deleted: return "Deleted — all selected resources confirmed absent"
      }
    }
    if model.postBlockers != nil || model.inspection?.state == .blocked { return "Blocked — no new cleanup admitted" }
    if model.requestId != nil { return "Requested or uncertain — check the exact receipt" }
    if model.inspection?.state == .eligible { return "Eligible — review and confirm the exact selection" }
    return "Deletion not confirmed"
  }

  private func consequences(_ plan: RetainedCleanupPlan) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      DisclosureGroup("Exact binding · v\(plan.version) · generation \(plan.generation)") {
        Text("Session: \(plan.sessionId)\nBinding: \(plan.binding)")
          .font(.caption.monospaced()).textSelection(.enabled)
      }
      Text("Exact resource targets").font(.headline)
      ForEach(Array(plan.resources.enumerated()), id: \.offset) { index, target in
        VStack(alignment: .leading, spacing: 3) {
          Text(target.role.label).font(.callout.weight(.semibold))
          Text(target.id).font(.caption.monospaced()).fixedSize(horizontal: false, vertical: true)
          Text("Namespace: \(target.namespace)").font(.caption.monospaced()).foregroundStyle(RecoveryPalette.secondary)
          if let progress = model.receipt?.resources[index] {
            Text(progress.state.label).font(.caption.weight(.semibold))
          }
        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
      }
      entries("Permanently lost", plan.dataLoss)
      entries("Retained", plan.retained)
      entries("Not reclaimed", plan.notReclaimed)
    }.recoverySurface()
  }

  private func entries(_ title: String, _ values: [String]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.headline)
      ForEach(Array(values.enumerated()), id: \.offset) { _, value in Text(value).font(.callout) }
    }
  }
}
