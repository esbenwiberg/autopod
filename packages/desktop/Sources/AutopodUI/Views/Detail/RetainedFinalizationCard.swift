import AutopodClient
import SwiftUI

/// Discovery is read-only. Custody, not a guessed local status, grants the actions.
struct RetainedFinalizationCard: View {
  let podId: String
  let actions: RetainedFinalizationActions
  @State private var snapshot: RetainedFinalizationView?
  @State private var error: String?
  @State private var showSheet = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let snapshot, !snapshot.custody.isEmpty || snapshot.operation != nil {
        HStack {
          Label(snapshot.operation?.state == .finalized ? "Finalized — source and resources retained" : "Recovery owns this source", systemImage: "lock.doc")
          Spacer()
          Button("Finalize retained work…") { showSheet = true }
            .accessibilityIdentifier("retained-finalization-open")
        }.font(.callout).padding(10).background(.orange.opacity(0.08))
      } else if let error {
        Text(error).font(.caption).foregroundStyle(.secondary).padding(8)
      }
    }
    .task { await load() }
    .sheet(isPresented: $showSheet, onDismiss: { Task { await load() } }) {
      RetainedFinalizationSheet(podId: podId, actions: actions)
    }
  }

  private func load() async {
    do { snapshot = try await actions.load(podId); error = nil }
    catch DaemonError.notFound { error = "Retained-work finalization requires a compatible daemon." }
    catch { self.error = "Could not inspect retained work: \(error.localizedDescription)" }
  }
}

struct RetainedFinalizationSheet: View {
  let actions: RetainedFinalizationActions
  let embedded: Bool
  @State private var model: RetainedFinalizationModel
  @State private var confirmation: RetainedFinalizationMode?
  @Environment(\.dismiss) private var dismiss

  init(podId: String, actions: RetainedFinalizationActions, model: RetainedFinalizationModel? = nil, embedded: Bool = false) {
    self.actions = actions; self.embedded = embedded
    _model = State(initialValue: model ?? RetainedFinalizationModel(podId: podId, actions: actions))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Finalize retained work").font(.title2.bold())
        Spacer()
        Button("Check status") { Task { await model.refresh(actions) } }
          .disabled(model.busy).accessibilityIdentifier("retained-finalization-refresh")
        if !embedded { Button("Done") { dismiss() }.disabled(model.busy).keyboardShortcut(.cancelAction) }
      }
      Text(model.podId).font(.caption.monospaced()).textSelection(.enabled)
      Text("Neither action deletes source, reports, custody evidence or recovery resources. Stopping is not completion. Retained storage may still incur costs.")
        .font(.callout).foregroundStyle(.secondary)
      if model.busy { ProgressView().controlSize(.small) }
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
          if let receipt = model.receipt {
            Text(receipt.state == .pending ? "Not finalized — reconciliation pending" :
              receipt.request.mode == .stopRetain ? "Stopped with work retained — not completed" : "External merged delivery verified")
              .font(.headline).accessibilityIdentifier("retained-finalization-outcome")
            Text(receipt.message).textSelection(.enabled)
          }
          if let snapshot = model.snapshot {
            Text("Observed status: \(snapshot.status) · generation \(snapshot.generation)").font(.caption)
            ForEach(Array(snapshot.blockers.enumerated()), id: \.offset) { _, message in
              Text(message).font(.callout).foregroundStyle(.orange)
            }
            DisclosureGroup("Source custody and exact selection") {
              ForEach(Array(snapshot.custody.enumerated()), id: \.offset) { _, owner in
                Text("\(owner.kind): \(owner.id)").font(.caption.monospaced()).textSelection(.enabled)
              }
              Text(snapshot.binding).font(.caption.monospaced()).textSelection(.enabled)
            }
          }
          if let pending = model.pending {
            Text("Saved request: \(pending.requestKey)\nAction: \(pending.mode.rawValue)\nReason: \(pending.reason)")
              .font(.caption).textSelection(.enabled)
            if model.receipt?.state != .finalized {
              Text("Check status is read-only. Reconcile sends this exact saved request, never a new stop or merge decision.")
                .font(.caption).foregroundStyle(.secondary)
              Button("Reconcile saved request") { Task { await model.reconcile(actions) } }
                .disabled(!model.canReconcile).accessibilityIdentifier("retained-finalization-reconcile")
              if model.canDiscardRejected {
                Button("Review a new decision") { Task { await model.discardRejected(actions) } }
                Text("The saved request was rejected and does not own the observed server intent. Only this local rejected draft will be discarded.")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          } else {
            TextField("Reason (10–4000 characters)", text: $model.reason, axis: .vertical)
              .textFieldStyle(.roundedBorder).lineLimit(2...5).disabled(model.busy)
              .accessibilityIdentifier("retained-finalization-reason")
            Text("Verify merged delivery checks the recorded PR and proves it includes the retained source. An open PR cannot complete this pod.")
              .font(.callout).foregroundStyle(.secondary)
            Button("Verify merged delivery…") { confirmation = .completeMerged }
              .disabled(!model.canSubmit(.completeMerged))
              .accessibilityIdentifier("retained-finalization-complete")
            Text("Stop and retain ends the pod only after execution is confirmed stopped. It does not merge the PR or claim the task succeeded.")
              .font(.callout).foregroundStyle(.secondary)
            Button("Stop and retain work…") { confirmation = .stopRetain }
              .disabled(!model.canSubmit(.stopRetain))
              .accessibilityIdentifier("retained-finalization-stop")
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(embedded ? 0 : 20).frame(width: embedded ? nil : 620, height: embedded ? nil : 580)
    .background(Color(nsColor: .windowBackgroundColor))
    .interactiveDismissDisabled(model.busy)
    .task { await model.refresh(actions) }
    .confirmationDialog("Finalize this exact retained source?", isPresented: Binding(
      get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
        if let mode = confirmation {
          Button(mode == .stopRetain ? "Stop and retain work" : "Verify merged delivery") {
            confirmation = nil
            Task { await model.submit(mode, actions: actions) }
          }
        }
        Button("Cancel", role: .cancel) { confirmation = nil }
      } message: {
        Text(confirmation == .stopRetain
          ? "This ends execution without claiming completion. All source and recovery resources remain retained. Unknown execution or competing publication still blocks this action."
          : "The daemon must prove that the recorded PR was merged and includes the retained source. No merge or push is requested. Source, reports and resources remain retained.")
      }
  }
}
