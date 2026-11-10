import AutopodClient
import SwiftUI

/// Discovery is read-only, including for a running task; eligibility belongs to the daemon.
struct StalledWorkerRecoveryCard: View {
  let podId: String
  let actions: StalledWorkerRecoveryActions
  var onOpenValidation: () -> Void = {}
  @State private var showing = false

  var body: some View {
    HStack {
      Label("Execution blocked or no longer progressing?", systemImage: "arrow.triangle.2.circlepath")
      Spacer()
      Button("Inspect stalled execution…") { showing = true }
        .accessibilityIdentifier("stalled-worker-recovery-open")
    }
    .font(.callout).padding(10).background(.orange.opacity(0.08))
    .sheet(isPresented: $showing) {
      StalledWorkerRecoverySheet(podId: podId, actions: actions, onOpenValidation: {
        showing = false
        onOpenValidation()
      })
    }
  }
}

struct StalledWorkerRecoverySheet: View {
  let actions: StalledWorkerRecoveryActions
  let onOpenValidation: () -> Void
  let embedded: Bool
  @State private var model: StalledWorkerRecoveryModel
  @State private var confirming = false
  @Environment(\.dismiss) private var dismiss

  init(podId: String, actions: StalledWorkerRecoveryActions, embedded: Bool = false,
       model: StalledWorkerRecoveryModel? = nil, onOpenValidation: @escaping () -> Void = {}) {
    self.actions = actions; self.embedded = embedded
    self.onOpenValidation = onOpenValidation
    _model = State(initialValue: model ?? StalledWorkerRecoveryModel(podId: podId, actions: actions))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Stop a stalled run and retain its work").font(.title2.bold())
        Spacer()
        Button("Inspect / refresh") { Task { await model.refresh(actions) } }.disabled(model.busy)
        if !embedded { Button("Done") { dismiss() }.disabled(model.busy).keyboardShortcut(.cancelAction) }
      }
      Text(model.podId).font(.caption.monospaced()).textSelection(.enabled)
      Text("Inspection does not stop anything. An explicit stop retains the Docker resource and archives its workspace before releasing the old run. It does not pass checks, run a worker, publish or merge.")
        .font(.callout)
      if model.busy { ProgressView().controlSize(.small) }
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          if let error = model.error {
            Text(error).foregroundStyle(.orange).textSelection(.enabled)
          }
          if let value = model.snapshot {
            Text("Recorded lifecycle: \(value.status) · generation \(value.generation)").font(.headline)
            if let failure = value.failureReason { Text(failure).textSelection(.enabled) }
            ForEach(Array(value.blockers.enumerated()), id: \.offset) { _, reason in
              Text(reason).foregroundStyle(.orange).textSelection(.enabled)
            }
            if let reason = value.guidanceBlocker {
              Text("Guidance remains pending: \(reason)").foregroundStyle(.orange).textSelection(.enabled)
            }
          }
          if let receipt = model.receipt {
            Text(receipt.message).textSelection(.enabled)
            Text(receipt.state == .settled ? "Execution settled — checks have NOT passed." : "Stop/preservation outcome pending — original resources remain held.")
              .font(.headline)
          }
          if model.receipt?.state == .settled {
            Button("Open Validation") { onOpenValidation() }
            Text("Retry checks and code repair are separate decisions. If the environment remains blocked, return to Recovery → Continue work to review a replacement. Pending guidance, retry limits, budgets, source ownership and native-check requirements still apply.")
              .font(.caption).foregroundStyle(.secondary)
          } else if let pending = model.pending {
            Text("Saved request: \(pending.requestKey)\nReason: \(pending.reason)").font(.caption.monospaced()).textSelection(.enabled)
            Text("Refresh only observes. After an uncertain response, reconcile this exact saved request; never create a second stop.")
              .font(.caption).foregroundStyle(.secondary)
            Button("Reconcile saved request") { Task { await model.reconcile(actions) } }
              .disabled(!model.canReconcile)
            if model.canDiscardRejected {
              Button("Discard confirmed rejected draft") { Task { await model.discardRejected(actions) } }
            }
          } else {
            TextField("Reason for stopping and retaining this execution (10–4000 characters)", text: $model.reason, axis: .vertical)
              .textFieldStyle(.roundedBorder).lineLimit(3...6).disabled(model.busy)
            Button("Stop execution and retain work…") { confirming = true }
              .disabled(!model.canSubmit).buttonStyle(.borderedProminent)
              .accessibilityIdentifier("stalled-worker-recovery-confirm")
          }
          Text("Unknown execution or incomplete preservation never becomes success. Missing identity and suspended sandboxes require their owning recovery control; Kick/Kill is not an automatic fallback.")
            .font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(embedded ? 0 : 20).frame(width: embedded ? nil : 720, height: embedded ? nil : 600)
    .interactiveDismissDisabled(model.busy)
    .task { await model.refresh(actions) }
    .confirmationDialog("Stop this exact execution and retain its work?", isPresented: $confirming, titleVisibility: .visible) {
      Button("Stop execution and retain work") { Task { await model.submit(actions: actions) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This interrupts the selected Docker container. Original files and reports are retained, and termination must be verified. No retry, validation pass, publication or merge is authorized.")
    }
  }
}
