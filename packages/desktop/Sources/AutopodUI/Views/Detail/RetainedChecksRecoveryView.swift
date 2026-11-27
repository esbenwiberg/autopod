import AutopodClient
import SwiftUI

struct RetainedChecksRecoveryView: View {
  let pod: Pod
  let actions: PodActions
  @Bindable var model: RetainedChecksRecoveryModel
  let openValidation: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        RecoverySectionTitle(title: "Run fresh checks on saved work",
          subtitle: "Use a clean saved Git commit in a separate container. Keep the original container, files and reports.")
        Text("No coding agent starts. Passing checks do not publish code, open a PR, or merge.")
          .font(.callout).foregroundStyle(RecoveryPalette.secondary)
        if model.busy { ProgressView("Checking recovery records…").controlSize(.small) }
        if let error = model.error {
          RecoveryNotice(title: model.pending == nil ? "Saved source unavailable" : "Request needs observation", message: error)
        }
        if model.invalidJournal {
          RecoveryNotice(title: "Saved decision could not be read",
            message: "No new request can be sent. Keep the original and its recovery records.")
        } else if let pending = model.pending {
          RecoveryStatusCard(title: "Saved request", symbol: "clock", detail: model.outcome)
          Text("Commit \(pending.preview.checkpointHead) · request \(pending.id)")
            .font(.caption.monospaced()).textSelection(.enabled)
        } else if let preview = model.preview {
          RecoveryStatusCard(title: "Clean host checkpoint", symbol: "checkmark.seal",
            detail: "Original Docker container is confirmed stopped. The old validation result stays in history.")
          Text("\(preview.branch) · \(preview.checkpointHead)")
            .font(.caption.monospaced()).textSelection(.enabled)
          Text("Only committed host source is checked. Uncollected changes and reports are not included.")
            .font(.caption).foregroundStyle(RecoveryPalette.secondary)
          TaskRetryCard(podId: pod.id, status: pod.status.rawValue, actions: actions, showsExecutionActions: false)
          TextField("Why run checks on this commit?", text: $model.reason)
          Toggle("Use this exact saved commit and keep the original", isOn: $model.confirmed)
          Button("Run fresh checks") { Task { await model.submit(actions.retainedChecks) } }
            .buttonStyle(.borderedProminent).disabled(!model.canSubmit)
            .accessibilityIdentifier("retained-checks-submit")
        }
        HStack {
          Button(model.pending == nil ? "Check saved source again" : "Check request status") {
            Task { await model.refresh(actions.retainedChecks, inspectSource: true) }
          }.disabled(model.busy)
          Button("Open Validation", action: openValidation)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { await model.refresh(actions.retainedChecks, inspectSource: true) }
  }
}
