import AutopodClient
import SwiftUI

struct ValidationHeldDockerControlView: View {
  let actions: ValidationHeldDockerActions
  @Bindable var model: ValidationHeldDockerModel
  var discard: () -> Void
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        RecoverySectionTitle(title: "Stop and retain", subtitle: "Validation-held local Docker execution. Files, reports, card and validation hold remain.")
        if let s = model.snapshot {
          Text(s.state == "stopped" ? "Stopped — validation remains unverified" : s.state.capitalized).font(.headline)
          Text(s.message).textSelection(.enabled)
          ForEach(Array((s.resources ?? []).enumerated()), id: \.offset) { _, r in
            Text("\(r.role.label): \(r.id)\nNamespace: \(r.namespace)").font(.caption.monospaced()).textSelection(.enabled)
          }
          ForEach(Array(s.blockers.enumerated()), id: \.offset) { _, b in
            Text("\(b.code): \(b.message)").textSelection(.enabled)
          }
          if s.state == "eligible" && model.saved == nil {
            TextField("Reason for stopping", text: $model.reason)
            Button("Confirm Stop and retain") { Task { await model.apply(actions) } }.disabled(!model.canSubmit)
          }
          if s.state == "stopped" {
            Button("Review Discard and delete…", action: discard)
            Text("Discard is a separate destructive confirmation. It may be blocked by host path or Git deletion safeguards.")
          }
        }
        if let error = model.error { Text(error).textSelection(.enabled) }
        Button("Observe exact Stop request / refresh preview") { Task { await model.refresh(actions) } }.disabled(model.busy)
        if model.saved != nil && model.observed && model.snapshot?.state != "stopped" {
          Button("Reconcile the same saved Stop request") { Task { await model.reconcile(actions) } }.disabled(model.busy)
        }
        if model.busy { ProgressView() }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.task { await model.refresh(actions) }
  }
}
