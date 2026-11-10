import AutopodClient
import SwiftUI

/// One entry replaces subsystem banners. Availability is discovery, not permission.
struct RecoveryHubCard: View {
  let pod: Pod
  let actions: PodActions
  var onOpenValidation: () -> Void = {}
  var onOpenEvidence: (() -> Void)?
  @State private var model: RecoveryHubModel
  @State private var showing = false

  init(pod: Pod, actions: PodActions, onOpenValidation: @escaping () -> Void = {},
       onOpenEvidence: (() -> Void)? = nil, model: RecoveryHubModel? = nil) {
    self.pod = pod; self.actions = actions; self.onOpenValidation = onOpenValidation; self.onOpenEvidence = onOpenEvidence
    _model = State(initialValue: model ?? RecoveryHubModel(podId: pod.id, actions: actions))
  }

  private var needsAttention: Bool {
    [.failed, .reviewRequired].contains(pod.status) || model.pendingRoute != nil || model.hasRetention
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if needsAttention {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "lifepreserver").foregroundStyle(.orange).padding(.top, 3)
          VStack(alignment: .leading, spacing: 4) {
            Text(model.pendingRoute == nil ? "Recovery options" : "Check an earlier recovery decision").font(.headline)
            Text(model.explanation(for: pod)).font(.callout).foregroundStyle(.secondary)
          }
          Spacer(minLength: 8)
          Button("Review recovery…") { showing = true }
            .accessibilityIdentifier("recovery-hub-open")
        }.padding(12).background(.orange.opacity(0.08))
      } else {
        HStack {
          if !model.errors.isEmpty { Text("Some recovery status could not be checked.").font(.caption).foregroundStyle(.secondary) }
          Spacer()
          Button("Recovery options…") { showing = true }
            .accessibilityIdentifier("recovery-hub-open")
        }.padding(.horizontal, 12).padding(.vertical, 6)
      }
    }
    .task(id: pod.status) {
      model.invalidateObservation()
      if pod.status != .running || pod.needsExecutionInspection { await model.refresh(pod: pod, actions: actions) }
    }
    .sheet(isPresented: $showing, onDismiss: { Task { await model.refresh(pod: pod, actions: actions) } }) {
      RecoveryHubSheet(pod: pod, actions: actions, model: model, onOpenValidation: onOpenValidation,
        onOpenEvidence: onOpenEvidence)
    }
  }
}

struct RecoveryHubSheet: View {
  let pod: Pod
  let actions: PodActions
  @State var model: RecoveryHubModel
  var onOpenValidation: () -> Void = {}
  var onOpenEvidence: (() -> Void)?
  @State private var route = RecoveryRoute.overview
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        if route != .overview {
          Button { route = .overview } label: { Label("Recovery", systemImage: "chevron.left") }
            .disabled(model.busy).accessibilityIdentifier("recovery-hub-back")
        } else { Text("Recovery").font(.title2.bold()) }
        Spacer()
        if route == .overview {
          Button("Check status") { Task { await model.refresh(pod: pod, actions: actions) } }.disabled(model.busy)
        }
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
      }
      Divider()
      switch route {
      case .overview: overview
      case .continueWork: continueWork
      case .recoverFiles:
        if actions.sandboxRecovery.available && RecoveryHubModel.canInspectSandbox(pod) {
          SandboxRecoverySheet(podId: pod.id, actions: actions.sandboxRecovery, purpose: .files,
            embedded: true, model: model.sandbox, onOpenFiles: evidenceAction)
        } else {
          VStack(alignment: .leading, spacing: 14) {
            Text("Recover files").font(.title2.bold())
            Text(model.savedWork)
            Text("Machine-only file recovery is not supported for this task on this connection. Saved evidence may still be available; it is not proof of the original environment's final contents.")
            evidenceButton
          }
          Spacer()
        }
      case .freeStorage:
        if actions.sandboxRecovery.available && RecoveryHubModel.canInspectSandbox(pod) {
          SandboxRecoverySheet(podId: pod.id, actions: actions.sandboxRecovery, purpose: .storage,
            embedded: true, model: model.sandbox)
        } else {
          VStack(alignment: .leading, spacing: 14) {
            Text("Free retained storage").font(.title2.bold())
            Text("No supported sandbox deletion control is available for this task. Stop-and-retain keeps resources; it is not cleanup.")
            Text("Verified archive-and-release is not available. Keep the original until its owning recovery can safely release it.")
          }
          Spacer()
        }
      case .repair:
        RepairContinuationSheet(podId: pod.id, actions: actions.repairContinuation, model: model.repair, embedded: true)
      case .stalled:
        StalledWorkerRecoverySheet(podId: pod.id, actions: actions.stalledWorkerRecovery, embedded: true,
          model: model.stalled, onOpenValidation: openValidation)
      case .finalization:
        RetainedFinalizationSheet(podId: pod.id, actions: actions.retainedFinalization, model: model.finalization, embedded: true)
      case .checks:
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            Text("Retry checks or repair failed checks").font(.title2.bold())
            Text("Retry checks does not start coding. Fix validation asks a worker to repair failures. Neither is a delivery approval or a way around retry limits.")
            ValidationRecoveryControls(podId: pod.id, status: pod.status.rawValue, actions: actions)
            Button("Open full validation and reports", action: openValidation)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }.padding(20).frame(width: 800, height: 740)
      .background(Color(nsColor: .windowBackgroundColor))
      .interactiveDismissDisabled(model.busy)
      .task { if !model.inspected { await model.refresh(pod: pod, actions: actions) } }
  }

  private var overview: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text("What happened?").font(.headline)
        Text(model.explanation(for: pod)).textSelection(.enabled)
        if let failure = model.failureSummary(for: pod) {
          Text(failure).font(.callout).textSelection(.enabled).lineLimit(4)
            .accessibilityIdentifier("recovery-hub-failure")
        }
        if let note = pod.executionRecoveryNote { Text(note).foregroundStyle(.orange).textSelection(.enabled) }
        if let failure = pod.errorSummary, !failure.isEmpty {
          DisclosureGroup("Recorded failure") { Text(failure).font(.callout).textSelection(.enabled) }
        }
        GroupBox("What is safe to rely on?") {
          VStack(alignment: .leading, spacing: 10) {
            fact("Saved work", model.savedWork)
            fact("Execution", model.execution)
            fact("Storage", model.storage)
          }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
        }
        if model.refreshing { ProgressView("Checking recovery records…").controlSize(.small) }
        if model.observationsDisagree {
          Text("The task changed while status was being checked. Check status again before choosing a new action.")
            .foregroundStyle(.orange).accessibilityIdentifier("recovery-hub-stale")
        }
        if let pending = model.pendingRoute {
          VStack(alignment: .leading, spacing: 8) {
            Text("First, check the saved decision").font(.headline)
            Text("A missing response does not prove failure. Opening its recorded outcome does not submit another request.")
            Button("Review the recorded outcome") { route = pending }.buttonStyle(.borderedProminent)
              .disabled(model.busy).accessibilityIdentifier("recovery-hub-pending")
          }
        }
        Text("What do you want to do?").font(.headline)
        option("Continue work", detail: "Retry checks, repair code, or inspect a stalled run. No implicit publish or merge.",
          icon: "arrow.right.circle", destination: .continueWork)
        option("Recover files", detail: "Inspect saved files or start the original machine for recovery only.",
          icon: "doc.on.doc", destination: .recoverFiles)
        option("Free storage", detail: "Review what would be lost before deleting. Safe archive-and-release is not yet available.",
          icon: "externaldrive.badge.minus", destination: .freeStorage)
        if !model.errors.isEmpty {
          Text("Some observations are unavailable. Unknown does not mean safe to resume or delete.")
            .font(.callout).foregroundStyle(.orange)
        }
        DisclosureGroup("Technical details and unavailable observations") {
          VStack(alignment: .leading, spacing: 8) {
            Text("Pod: \(pod.id) · recorded status: \(pod.status.rawValue)")
            if let checkedAt = model.checkedAt { Text("Last inspection: \(checkedAt.formatted())") }
            ForEach(Array(model.errors.enumerated()), id: \.offset) { _, error in Text(error) }
            Text("Each action refreshes its owning policy. This overview does not grant permission or settle unknown execution.")
          }.font(.caption).textSelection(.enabled)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var continueWork: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Continue work").font(.title2.bold())
        Text("Choose the smallest next step. Opening an option checks eligibility; it does not start execution.")
        if !pod.isWorkspace {
          option("Retry checks or fix validation", detail: "Review the failed checks and current retry permission first.",
            icon: "checkmark.circle", destination: .checks)
          if actions.repairContinuation.available && [.failed, .reviewRequired, .validated].contains(pod.status) {
            option("Use a replacement environment", detail: "Review saved source and software changes. Coding starts only if the actual replacement qualifies.",
              icon: "wrench.and.screwdriver", destination: .repair)
          }
          if actions.stalledWorkerRecovery.available && [.running, .failed, .reviewRequired].contains(pod.status) {
            option("Inspect and stop a stalled run", detail: "Supported Docker runs only. Retain work and verify the stop before deciding what to do next.",
              icon: "pause.circle", destination: .stalled)
          }
          if actions.retainedFinalization.available && RecoveryHubModel.canInspectSandbox(pod) {
            option("End with work retained, or verify an existing merge", detail: "Does not publish, merge or free storage. An open PR cannot be marked delivered.",
              icon: "lock.doc", destination: .finalization)
          }
        } else { Text("This is an interactive workspace. Agent repair controls do not apply.") }
        Button("Open validation and reports", action: openValidation)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func fact(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label).font(.caption.bold()).foregroundStyle(.secondary)
      Text(value).font(.callout).textSelection(.enabled)
    }
  }

  private func option(_ title: String, detail: String, icon: String, destination: RecoveryRoute) -> some View {
    Button { route = destination } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: icon).frame(width: 20)
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.headline)
          Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(.caption)
      }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }.buttonStyle(.plain).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      .disabled(!model.canOpen(destination))
      .accessibilityIdentifier("recovery-route-\(destination.rawValue)")
  }

  @ViewBuilder private var evidenceButton: some View {
    if let evidenceAction { Button("Open saved files and evidence", action: evidenceAction) }
  }
  private var evidenceAction: (() -> Void)? {
    guard let onOpenEvidence else { return nil }
    return { dismiss(); onOpenEvidence() }
  }
  private func openValidation() { dismiss(); onOpenValidation() }
}
