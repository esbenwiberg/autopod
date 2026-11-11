import AutopodClient
import SwiftUI

/// Kept for standalone callers; pod detail uses the unified RecoveryHubCard.
struct SandboxRecoveryCard: View {
  let podId: String
  let actions: SandboxRecoveryActions
  @State private var snapshot: SandboxRecoveryState?
  @State private var loading = false
  @State private var error: String?
  @State private var showSheet = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let snapshot, !snapshot.resources.isEmpty {
        HStack {
          Label("Original environment retained", systemImage: "shippingbox")
          Spacer()
          Button("Review recovery…") { showSheet = true }
            .accessibilityIdentifier("sandbox-recovery-open")
        }.padding(10).background(.orange.opacity(0.08))
      } else if let error {
        HStack {
          Text(error).font(.caption).foregroundStyle(RecoveryPalette.secondary)
          Spacer()
          Button("Check recovery status") { Task { await load() } }.disabled(loading)
        }.padding(8)
      }
    }
    .task { await load() }
    .sheet(isPresented: $showSheet, onDismiss: { Task { await load() } }) {
      SandboxRecoverySheet(podId: podId, actions: actions)
    }
  }

  private func load() async {
    guard actions.available else { return }
    loading = true
    do { snapshot = try await actions.load(podId); error = nil }
    catch { self.error = "Could not check retained environments: \(error.localizedDescription)" }
    loading = false
  }
}

enum SandboxRecoveryPurpose { case all, files, storage }

struct SandboxRecoverySheet: View {
  let podId: String
  let actions: SandboxRecoveryActions
  var purpose: SandboxRecoveryPurpose = .all
  var embedded = false
  var onOpenFiles: (() -> Void)?
  @Environment(\.dismiss) private var dismiss
  @State private var model: SandboxRecoveryModel
  @State private var confirmation: SandboxRecoveryResource?

  init(podId: String, actions: SandboxRecoveryActions, purpose: SandboxRecoveryPurpose = .all,
       embedded: Bool = false, model: SandboxRecoveryModel? = nil, onOpenFiles: (() -> Void)? = nil) {
    self.podId = podId; self.actions = actions; self.purpose = purpose; self.embedded = embedded
    self.onOpenFiles = onOpenFiles
    _model = State(initialValue: model ?? SandboxRecoveryModel(podId: podId, actions: actions))
  }

  private var title: String {
    purpose == .files ? "Recover files" : purpose == .storage ? "Free retained storage" : "Recover files or free storage"
  }

  private var selectedDecision: SandboxRecoveryRequest? {
    purpose == .files ? model.pendingStart : purpose == .storage ? model.pendingAbandon : model.pending
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text(title).font(.title3.weight(.semibold))
        Spacer()
        Button("Check status") { Task { await model.refresh(actions) } }.disabled(model.busy)
        if !embedded { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy) }
      }.controlSize(.small)
      Text(purpose == .storage
        ? "Deleting the original environment may lose files and reports that were never saved. This also attempts to remove the pod; cleanup can remain blocked."
        : "Starting the selected retained environment lets you recover files. It does not resume coding, run checks or publish changes.")
        .font(.callout).foregroundStyle(RecoveryPalette.secondary)
      if model.busy { ProgressView("Checking the recorded outcome…").controlSize(.small) }
      if let error = model.error { RecoveryNotice(title: "Outcome needs a status check", message: error) }
      if let notice = model.notice { RecoveryNotice(title: "Recorded outcome", message: notice, tone: .standard, symbol: "info.circle") }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let pending = selectedDecision {
            RecoveryNotice(title: "A decision is already saved", message: pending.action == "start"
              ? "The start response may have been lost. Check status; another start will not be sent."
              : "Continue this same deletion decision if needed. It will never target a replacement environment.", symbol: "clock")
            if model.canDiscardRejected {
              Button("Review a new decision after confirmed rejection") { Task { await model.discardRejected(actions) } }
            }
          }
          if selectedDecision == nil || purpose == .storage {
            VStack(alignment: .leading, spacing: 10) {
              RecoverySectionTitle(title: purpose == .storage ? "Deletion reason" : "Recovery reason",
                subtitle: purpose == .storage && model.pendingAbandon != nil
                  ? "This reason is for a new decision. Saved decisions are unchanged."
                  : "10–4000 characters. Recorded only when you confirm an action.")
              TextField("Describe why this action is needed", text: $model.reason, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(model.busy)
                .accessibilityIdentifier("sandbox-recovery-reason")
            }.recoverySurface()
          }
          if purpose != .files {
            VStack(alignment: .leading, spacing: 12) {
              Label("Deletion is permanent", systemImage: "exclamationmark.triangle")
                .font(.callout.weight(.semibold)).foregroundStyle(RecoveryTone.destructive.color)
              Text("This is a discard action, not verified archive-and-release. Recover anything you need first.")
                .font(.callout).foregroundStyle(RecoveryPalette.secondary)
              Toggle("I accept losing files and reports that have not been saved.", isOn: $model.acknowledgeLoss)
                .disabled(model.busy).accessibilityIdentifier("sandbox-recovery-accept-loss")
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
              .background(RecoveryTone.destructive.color.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
              .overlay(RoundedRectangle(cornerRadius: 12).stroke(RecoveryTone.destructive.color.opacity(0.24)))
          }
          if let snapshot = model.snapshot {
            if purpose == .storage && snapshot.operations.contains(where: { $0.action == "abandon" && $0.generation != snapshot.generation }) {
              Text("Earlier deletion decisions belong to an older task state. Their evidence is retained. Deleting a current selection requires a new reason, loss acknowledgement and confirmation.")
                .font(.callout).foregroundStyle(RecoveryPalette.secondary)
            }
            if snapshot.resources.isEmpty { Text("No retained sandbox environments were found.") }
            ForEach(snapshot.resources) { resource in resourceCard(resource, snapshot: snapshot) }
            DisclosureGroup("Technical details and recovery history") {
              VStack(alignment: .leading, spacing: 8) {
                Text("Pod: \(podId) · generation \(snapshot.generation)")
                if let start = model.pendingStart { Text("Saved start: \(start.id)\nReason: \(start.reason)") }
                ForEach(Array(model.pendingAbandons.values.sorted { $0.id < $1.id }.enumerated()), id: \.offset) { _, abandon in
                  Text("Saved deletion: \(abandon.id)\nReason: \(abandon.reason)")
                }
                ForEach(snapshot.wakeups) { wakeup in
                  Text("Start \(wakeup.id) · \(wakeup.startedAt)\nOutcome: \(wakeup.settledBy ?? "unresolved")")
                  ForEach(Array(wakeup.evidence.enumerated()), id: \.offset) { _, item in
                    Text("\(item.recordedAt): \(item.kind), \(item.status.map(String.init) ?? item.errorCode ?? "unknown")")
                  }
                }
                ForEach(snapshot.operations) { operation in
                  Text("\(operation.action) · \(operation.id) · \(operation.userId)\n\(operation.reason)\n\(operation.completedAt == nil ? "Completion unverified" : "Confirmed complete")")
                }
              }.font(.caption.monospaced()).textSelection(.enabled)
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      Text("Stopped environments may still incur storage charges. Deleting this sandbox does not remove independent snapshots, images or volumes.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 10).overlay(alignment: .top) { DesktopTheme.line.frame(height: 1) }
    }
    .padding(embedded ? 0 : 20)
    .frame(width: embedded ? nil : 680, height: embedded ? nil : 650)
    .background(DesktopTheme.canvas).tint(DesktopTheme.accent)
    .interactiveDismissDisabled(model.busy)
    .task { await model.refresh(actions) }
    .onChange(of: model.podDeleted) { _, deleted in if deleted { dismiss() } }
    .confirmationDialog("Discard unsaved data and delete?", isPresented: Binding(
      get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
        if let resource = confirmation {
          Button("Discard data and delete", role: .destructive) {
            confirmation = nil
            Task { await model.submit(resource, action: "abandon", actions: actions) }
          }
        }
        Button("Cancel", role: .cancel) { confirmation = nil }
      } message: {
        Text("Environment \(confirmation?.sandboxId ?? "") will be permanently deleted. Unsaved files and reports may be lost. Pod deletion is also attempted, but only if all other ownership checks and cleanup succeed. Audit evidence is retained.")
      }
  }

  @ViewBuilder private func resourceCard(_ resource: SandboxRecoveryResource, snapshot: SandboxRecoveryState) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Retained environment").font(.headline)
        Spacer()
        Text(String(resource.sandboxId.prefix(8))).font(.caption.monospaced()).textSelection(.enabled)
          .padding(.horizontal, 7).padding(.vertical, 4)
          .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 5))
      }
      Text(resource.providerState == "unknown" ? "Environment state could not be verified" : "Provider reports: \(resource.providerState)")
        .font(.callout).foregroundStyle(RecoveryPalette.secondary)
      if !resource.pendingIntentIds.isEmpty && resource.abandonment?.completedAt == nil {
        Text("An earlier start has an unknown outcome. Stopped does not mean that request failed; another start is blocked.")
          .foregroundStyle(.orange)
      }
      if let error = resource.observationError { Text("Status check: \(error)").font(.callout).foregroundStyle(.orange) }
      if purpose != .storage {
        if let blocked = resource.startBlocked { Text("Cannot start yet: \(blocked)").font(.callout).foregroundStyle(RecoveryPalette.secondary) }
        Button("Start environment for file recovery") {
          Task { await model.submit(resource, action: "start", actions: actions) }
        }.buttonStyle(.borderedProminent).controlSize(.small)
          .disabled(!model.canStart(resource)).accessibilityIdentifier("sandbox-recovery-start")
        if let onOpenFiles { Button("View files and saved evidence", action: onOpenFiles).disabled(model.busy) }
      }
      if purpose != .files {
        if let saved = model.pendingAbandons[resource.resourceKey] {
          Text("Saved deletion reason: \(saved.reason). Continuing uses this exact decision, not edited fields.")
            .font(.callout).foregroundStyle(RecoveryPalette.secondary)
        }
        if let blocked = resource.abandonBlocked { Text("Cannot delete yet: \(blocked)").font(.callout).foregroundStyle(RecoveryPalette.secondary) }
        Button(resource.abandonment == nil ? "Discard unsaved data and delete…" : "Continue the recorded deletion…", role: .destructive) {
          confirmation = resource
        }.buttonStyle(.bordered).tint(RecoveryTone.destructive.color).controlSize(.small)
          .disabled(!model.canAbandon(resource)).accessibilityIdentifier("sandbox-recovery-abandon")
      }
      DisclosureGroup("Environment identity") {
        Text("\(resource.sandboxId)\n\(resource.resourceKey)\nObserved: \(resource.observedAt)")
          .font(.caption.monospaced()).textSelection(.enabled)
      }
    }.recoverySurface(inset: 16)
  }
}
