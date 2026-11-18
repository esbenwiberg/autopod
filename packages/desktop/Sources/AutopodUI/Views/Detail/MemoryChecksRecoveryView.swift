import AutopodClient
import SwiftUI

struct MemoryChecksRecoveryView: View {
  @Bindable var model: MemoryChecksRecoveryModel
  let actions: MemoryChecksActions
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        RecoverySectionTitle(title: "Retry the saved checks with more effective memory", subtitle: "Checks and independent review only. No coding worker or delivery.")
        Text(model.savedWork).textSelection(.enabled).font(.callout).recoverySurface()
        if let measured = model.memory?.priorMemory {
          Text("Recorded effective test heap: \(ByteCountFormatter.string(fromByteCount: Int64(measured.heapLimitBytes), countStyle: .memory)). Effective container limit: \(ByteCountFormatter.string(fromByteCount: Int64(measured.containerLimitBytes), countStyle: .memory)).")
            .font(.caption).foregroundStyle(RecoveryPalette.secondary)
        }
        if model.hasSavedRequest {
          Text(model.outcome).font(.callout)
          if let pending = model.pending { Text("Saved request: \(pending.id)").textSelection(.enabled).font(.caption) }
          Button("Observe saved request") { Task { await model.refresh(actions) } }.disabled(model.busy)
            .accessibilityIdentifier("memory-checks-observe")
        } else {
          Text(model.nextStep).font(.callout)
          if model.memory?.state == "requires_candidate" && !model.stale {
            TextField("Compatible execution profile ID", text: $model.profileId)
              .accessibilityIdentifier("memory-checks-profile")
            Button("Preview candidate configuration") { Task { await model.loadPreview(actions) } }
              .disabled(!model.canPreview)
            if let preview = model.preview {
              Text("Candidate \(preview.profileId) · \(preview.digest)").font(.caption).textSelection(.enabled)
              Text("Selected Docker allocation: \(preview.main.memoryGb.map { String($0) + " GB memory" } ?? "memory unspecified") · \(preview.main.cpus.map { String($0) + " CPUs" } ?? "CPU limit unspecified") · \(preview.main.storageGb.map { String($0) + " GB storage" } ?? "storage uses the existing Docker host").")
                .font(.callout).textSelection(.enabled)
              Text("Selected software base: \(preview.resolvedEnvironment.pinnedBase)\nSoftware image key: \(preview.resolvedEnvironment.imageKey)")
                .font(.caption).textSelection(.enabled)
              Text("Configuration preview only. After confirmation the actual allocation and effective heap of the unchanged test command must improve before any checks dispatch. The task keeps its existing allowance and retry permission. More memory does not guarantee a pass.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
              TextField("Reason for this checks-only attempt", text: $model.reason, axis: .vertical)
              Toggle("I confirm this saved commit and candidate for checks only within existing permission", isOn: $model.confirmed)
              Button("Confirm conditional checks-only attempt") { Task { await model.submit(actions) } }
                .buttonStyle(.borderedProminent).disabled(!model.canConfirm)
                .accessibilityIdentifier("memory-checks-confirm")
            }
          }
          Button("Inspect again") { Task { await model.refresh(actions) } }.disabled(model.busy)
        }
        if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        Text("Original source, failure history, accounting and reports remain retained. Passing checks still require separate human approval. A lost response is observed using the exact saved request.")
          .font(.caption).foregroundStyle(RecoveryPalette.secondary)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
