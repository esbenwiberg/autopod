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
    [.failed, .reviewRequired].contains(pod.status) || model.pendingRoute != nil || model.hasRetention || model.fork.inspection?.lineage != nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if needsAttention {
        HStack(alignment: .center, spacing: 12) {
          RecoveryIcon(symbol: "lifepreserver")
          VStack(alignment: .leading, spacing: 4) {
            Text(model.pendingRoute == nil ? "Recovery options" : "Check an earlier recovery decision")
              .font(.callout.weight(.semibold))
            Text(model.explanation(for: pod)).font(.callout).foregroundStyle(RecoveryPalette.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 8)
          Button("Review recovery…") { showing = true }
            .controlSize(.small).accessibilityIdentifier("recovery-hub-open")
        }.padding(14).recoverySurface(inset: 0).padding(.horizontal, 16).padding(.vertical, 10)
      } else {
        HStack {
          if !model.errors.isEmpty { Text("Some recovery status could not be checked.").font(.caption).foregroundStyle(RecoveryPalette.secondary) }
          Spacer()
          Button("Recovery options…") { showing = true }
            .controlSize(.small).accessibilityIdentifier("recovery-hub-open")
        }.padding(.horizontal, 16).padding(.vertical, 6)
      }
    }.tint(DesktopTheme.accent)
    .task(id: pod.status) {
      model.invalidateObservation()
      if pod.status != .running || pod.needsExecutionInspection || model.fork.needsObservation { await model.refresh(pod: pod, actions: actions) }
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
    VStack(alignment: .leading, spacing: 0) {
      toolbar
      DesktopTheme.line.frame(height: 1)
      destination.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      if route == .overview {
        DesktopTheme.line.frame(height: 1)
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "lock.shield").accessibilityHidden(true)
          Text("You review the consequences before taking action. Existing permissions and checks still apply.")
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
        }.font(.caption).foregroundStyle(RecoveryPalette.secondary).padding(.horizontal, 24).padding(.vertical, 14)
          .background(DesktopTheme.surface)
      }
    }
    .frame(minWidth: 660, idealWidth: 820, maxWidth: 1000, minHeight: 640, idealHeight: 780, maxHeight: 1000)
    .background(DesktopTheme.canvas).tint(DesktopTheme.accent)
    .interactiveDismissDisabled(model.busy)
    .task { if !model.inspected { await model.refresh(pod: pod, actions: actions) } }
  }

  private var toolbar: some View {
    HStack(spacing: 12) {
      if route == .overview { RecoveryIcon(symbol: "lifepreserver") }
      VStack(alignment: .leading, spacing: 4) {
        if route != .overview {
          Button { route = .overview } label: { Label("Recovery", systemImage: "chevron.left") }
            .buttonStyle(.plain).foregroundStyle(DesktopTheme.accent).font(.callout.weight(.medium))
            .disabled(model.busy).accessibilityIdentifier("recovery-hub-back")
        } else { Text("Recovery").font(.headline) }
        Text("\(pod.profileName) / \(pod.branch)").font(.caption).foregroundStyle(RecoveryPalette.secondary)
          .lineLimit(1).truncationMode(.middle).help("\(pod.profileName) / \(pod.branch)")
      }
      Spacer(minLength: 12)
      if route == .overview {
        Button { Task { await model.refresh(pod: pod, actions: actions) } } label: {
          Label("Check status", systemImage: "arrow.clockwise")
        }.disabled(model.busy)
      }
      Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
    }.controlSize(.small).padding(.horizontal, 24).padding(.vertical, 16)
      .background(DesktopTheme.surface)
  }

  @ViewBuilder private var destination: some View {
    switch route {
    case .overview: overview
    case .continueWork: continueWork
    case .recoverFiles:
      FileRecoveryView(actions: actions, model: model.files, sandbox: model.sandbox, onOpenEvidence: evidenceAction)
    case .freeStorage:
      if actions.sandboxRecovery.available && RecoveryHubModel.canInspectSandbox(pod) {
        SandboxRecoverySheet(podId: pod.id, actions: actions.sandboxRecovery, purpose: .storage,
          embedded: true, model: model.sandbox)
      } else {
        VStack(alignment: .leading, spacing: 18) {
          RecoverySectionTitle(title: "Free retained storage", subtitle: "Retention and task completion are separate.")
          RecoveryNotice(title: "Deletion unavailable", message: "No supported sandbox deletion control is available for this task. Stop-and-retain keeps resources; it is not cleanup.")
          Text("Verified archive-and-release is not available. Keep the original until its owning recovery can safely release it.")
            .font(.callout).foregroundStyle(RecoveryPalette.secondary)
        }
      }
    case .freshPod:
      RecoveryForkView(actions: actions.recoveryFork, model: model.fork, onNavigate: { dismiss() })
    case .repair:
      RepairContinuationSheet(podId: pod.id, actions: actions.repairContinuation, model: model.repair, embedded: true)
    case .stalled:
      StalledWorkerRecoverySheet(podId: pod.id, actions: actions.stalledWorkerRecovery, embedded: true,
        model: model.stalled, onOpenValidation: openValidation)
    case .finalization:
      RetainedFinalizationSheet(podId: pod.id, actions: actions.retainedFinalization, model: model.finalization, embedded: true)
    case .checks:
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          RecoverySectionTitle(title: "Retry checks or repair failed checks", subtitle: "Choose whether checks alone or coding repair is needed.")
          Text("Retry checks does not start coding. Fix validation asks a worker to repair failures. Neither is a delivery approval or a way around retry limits.")
            .font(.callout).foregroundStyle(RecoveryPalette.secondary)
          ValidationRecoveryControls(podId: pod.id, status: pod.status.rawValue, actions: actions)
            .recoverySurface()
          Button("Open full validation and reports", action: openValidation)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private var overview: some View {
    GeometryReader { geometry in
      ScrollView { overviewContents(compact: geometry.size.width < 700) }
    }
  }

  private func overviewContents(compact: Bool) -> some View {
    VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .firstTextBaseline) {
            Text("Recovery overview").font(.title2.weight(.semibold))
            Spacer(minLength: 8)
            RecoveryBadge(title: model.pendingRoute != nil ? "Decision pending" : "Review before acting")
          }
          Text("WHAT HAPPENED").font(.caption2.weight(.semibold)).tracking(1).foregroundStyle(RecoveryPalette.secondary)
          Text(model.explanation(for: pod)).font(.body).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          if let failure = model.failureSummary(for: pod) {
            HStack(alignment: .top, spacing: 8) {
              Image(systemName: "exclamationmark.circle").foregroundStyle(RecoveryTone.attention.color).padding(.top, 2).accessibilityHidden(true)
              Text(failure).font(.callout).textSelection(.enabled).lineLimit(4)
                .accessibilityIdentifier("recovery-hub-failure")
            }
          }
          if let note = pod.executionRecoveryNote { Text(note).font(.callout).foregroundStyle(RecoveryPalette.secondary).textSelection(.enabled) }
        }.frame(maxWidth: .infinity, alignment: .leading).recoverySurface()

        VStack(alignment: .leading, spacing: 12) {
          RecoverySectionTitle(title: "What is safe to rely on?", subtitle: "Saved work, execution and storage are checked separately.")
          if !compact {
            HStack(alignment: .top, spacing: 12) {
              statusCard("Saved work", symbol: "doc.text", detail: model.savedWork)
              statusCard("Execution", symbol: "waveform.path", detail: model.execution)
              statusCard("Storage", symbol: "externaldrive", detail: model.storage)
            }.fixedSize(horizontal: false, vertical: true)
          } else {
            VStack(spacing: 10) {
              statusCard("Saved work", symbol: "doc.text", detail: model.savedWork)
              statusCard("Execution", symbol: "waveform.path", detail: model.execution)
              statusCard("Storage", symbol: "externaldrive", detail: model.storage)
            }
          }
        }
        if model.refreshing { ProgressView("Checking recovery records…").controlSize(.small) }
        if model.observationsDisagree {
          RecoveryNotice(title: "The task changed during inspection", message: "Check status again before choosing a new action.")
            .accessibilityIdentifier("recovery-hub-stale")
        }
        if let pending = model.pendingRoute {
          VStack(alignment: .leading, spacing: 12) {
            RecoveryNotice(title: "First, check the saved decision", message: "A missing response does not prove failure. Opening its recorded outcome does not submit another request.", symbol: "clock")
            Button("Review the recorded outcome") { route = pending }.buttonStyle(.borderedProminent)
              .disabled(model.busy).accessibilityIdentifier("recovery-hub-pending")
          }
        }
        VStack(alignment: .leading, spacing: 12) {
          RecoverySectionTitle(title: "How would you like to proceed?", subtitle: "Choose an outcome. Nothing runs when you open an option.")
          if !compact {
            HStack(alignment: .top, spacing: 12) {
              goalCard("Continue work", detail: "Retry, repair, or continue a checkpoint in a fresh pod. No implicit publish or merge.",
                icon: "arrow.right.circle", destination: .continueWork)
              goalCard("Recover files", detail: "Browse saved copies, inspect the original if needed, and save selected files to this Mac.",
                icon: "doc.on.doc", destination: .recoverFiles)
              goalCard("Free storage", detail: "Review data loss before deleting. Safe archive-and-release is not yet available.",
                icon: "externaldrive.badge.minus", destination: .freeStorage)
            }.fixedSize(horizontal: false, vertical: true)
          } else {
            VStack(spacing: 10) {
              option("Continue work", detail: "Retry, repair, or continue a checkpoint in a fresh pod. No implicit publish or merge.", icon: "arrow.right.circle", destination: .continueWork)
              option("Recover files", detail: "Browse saved copies, inspect the original if needed, and save selected files to this Mac.", icon: "doc.on.doc", destination: .recoverFiles)
              option("Free storage", detail: "Review data loss before deleting. Safe archive-and-release is not yet available.", icon: "externaldrive.badge.minus", destination: .freeStorage)
            }
          }
        }
        if !model.errors.isEmpty {
          RecoveryNotice(title: "Some observations are unavailable", message: "Unknown does not mean safe to resume or delete.")
        }
        DisclosureGroup("Technical details and unavailable observations") {
          VStack(alignment: .leading, spacing: 8) {
            Text("Pod: \(pod.id) · recorded status: \(pod.status.rawValue)")
            if let checkedAt = model.checkedAt { Text("Last inspection: \(checkedAt.formatted())") }
            if let failure = model.failureSummary(for: pod) { Text(failure) }
            if let failure = pod.errorSummary, !failure.isEmpty { Text(failure) }
            ForEach(Array(model.errors.enumerated()), id: \.offset) { _, error in Text(error) }
            Text("Each action refreshes its owning policy. This overview does not grant permission or settle unknown execution.")
          }.font(.caption).textSelection(.enabled).padding(.top, 8)
        }.font(.callout).foregroundStyle(RecoveryPalette.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private var continueWork: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        RecoverySectionTitle(title: "Continue work", subtitle: "Choose the smallest next step. Opening an option checks eligibility; it does not start execution.")
        if !pod.isWorkspace {
          if actions.recoveryFork.available {
            option("Continue in a fresh pod", detail: "Carry a verified host checkpoint, visible history, failure context and your instructions. Keep the original and share task limits.", icon: "arrow.triangle.branch", destination: .freshPod)
          }
          option("Retry checks or fix validation", detail: "Review the failed checks and current retry permission first.", icon: "checkmark.circle", destination: .checks)
          if actions.repairContinuation.available && [.failed, .reviewRequired, .validated].contains(pod.status) {
            option("Use a replacement environment", detail: "Review saved source and software changes. Coding starts only if the actual replacement qualifies.", icon: "wrench.and.screwdriver", destination: .repair)
          }
          if actions.stalledWorkerRecovery.available && [.running, .failed, .reviewRequired].contains(pod.status) {
            option("Inspect and stop a stalled run", detail: "Supported Docker runs only. Retain work and verify the stop before deciding what to do next.", icon: "pause.circle", destination: .stalled)
          }
          if actions.retainedFinalization.available && RecoveryHubModel.canInspectSandbox(pod) {
            option("End with work retained, or verify an existing merge", detail: "Does not publish, merge or free storage. An open PR cannot be marked delivered.", icon: "lock.doc", destination: .finalization)
          }
        } else { Text("This is an interactive workspace. Agent repair controls do not apply.") }
        Button("Open validation and reports", action: openValidation).controlSize(.small)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func statusCard(_ title: String, symbol: String, detail: String) -> some View {
    RecoveryStatusCard(title: title, symbol: symbol, detail: detail)
  }

  private func goalCard(_ title: String, detail: String, icon: String, destination: RecoveryRoute) -> some View {
    Button { route = destination } label: {
      VStack(alignment: .leading, spacing: 12) {
        RecoveryIcon(symbol: icon, tone: destination == .freeStorage ? .destructive : .standard)
        Text(title).font(.headline)
        Text(detail).font(.callout).foregroundStyle(RecoveryPalette.secondary).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        HStack {
          Text(destination == .freeStorage ? "Review consequences" : "Review options").font(.caption.weight(.semibold))
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
        }.foregroundStyle(destination == .freeStorage ? RecoveryTone.destructive.color : DesktopTheme.accent)
      }.padding(16).frame(minWidth: 210, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }.buttonStyle(RecoveryNavigationStyle()).disabled(!model.canOpen(destination))
      .accessibilityIdentifier("recovery-route-\(destination.rawValue)")
  }

  private func option(_ title: String, detail: String, icon: String, destination: RecoveryRoute) -> some View {
    Button { route = destination } label: {
      HStack(alignment: .center, spacing: 12) {
        RecoveryIcon(symbol: icon, tone: destination == .freeStorage ? .destructive : .standard)
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.callout.weight(.semibold))
          Text(detail).font(.callout).foregroundStyle(RecoveryPalette.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(RecoveryPalette.secondary)
      }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }.buttonStyle(RecoveryNavigationStyle()).disabled(!model.canOpen(destination))
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
