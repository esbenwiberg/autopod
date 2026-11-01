import AutopodClient
import SwiftUI

/// Read-only observation on appearance; all mutations require an explicit human decision.
struct SandboxRecoveryCard: View {
  let podId: String
  let actions: SandboxRecoveryActions
  @State private var snapshot: SandboxRecoveryState?
  @State private var loading = false
  @State private var error: String?
  @State private var showSheet = false

  var body: some View {
    Group {
      if let snapshot, !snapshot.resources.isEmpty {
        HStack {
          Image(systemName: snapshot.resources.contains(where: { !$0.pendingIntentIds.isEmpty && $0.abandonment?.completedAt == nil })
                ? "exclamationmark.lock" : "shippingbox")
          Text(snapshot.resources.contains(where: { !$0.pendingIntentIds.isEmpty && $0.abandonment?.completedAt == nil })
               ? "Sandbox retained — recovery required before deletion" : "Retained sandbox")
            .font(.callout)
          Spacer()
          Button("Sandbox recovery…") { showSheet = true }
            .accessibilityIdentifier("sandbox-recovery-open")
        }
        .padding(10)
        .background(.orange.opacity(0.08))
      } else if let error {
        HStack {
          Text(error).font(.caption).foregroundStyle(.secondary)
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
    catch DaemonError.notFound { error = "Sandbox recovery requires a newer daemon." }
    catch { self.error = "Could not check sandbox recovery: \(error.localizedDescription)" }
    loading = false
  }
}

struct SandboxRecoverySheet: View {
  let podId: String
  let actions: SandboxRecoveryActions
  @Environment(\.dismiss) private var dismiss
  @State private var snapshot: SandboxRecoveryState?
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var reason = ""
  @State private var acknowledgeLoss = false
  @State private var confirmation: SandboxRecoveryResource?
  @State private var savedRequest: SandboxRecoveryRequest?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Sandbox recovery").font(.title2.bold())
        Spacer()
        Button("Check status") { Task { await refresh() } }.disabled(busy)
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      Text(podId).font(.caption.monospaced()).textSelection(.enabled)
      Text("Starting the sandbox does not continue the coding agent, run validation, publish changes, or reopen a PR. Continue task remains a separate action with its existing checks.")
        .font(.callout).foregroundStyle(.secondary)
      if busy { ProgressView().controlSize(.small) }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      if let notice { Text(notice).foregroundStyle(.secondary).textSelection(.enabled) }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let snapshot {
            if snapshot.resources.isEmpty { Text("No retained sandbox resources were found.") }
            ForEach(snapshot.resources) { resource in
              resourceCard(resource, snapshot: snapshot)
            }
            DisclosureGroup("Original wakeup evidence (\(snapshot.wakeups.count))") {
              ForEach(snapshot.wakeups) { wakeup in
                VStack(alignment: .leading, spacing: 4) {
                  Text(wakeup.id).font(.caption.monospaced())
                  Text("Sandbox: \(wakeup.sandboxId)")
                  Text("Requested: \(wakeup.startedAt)")
                  Text("Outcome: \(wakeup.settledBy ?? "unresolved — not proved rejected")")
                  if wakeup.evidence.isEmpty { Text("No transport response evidence recorded.") }
                  ForEach(Array(wakeup.evidence.enumerated()), id: \.offset) { _, item in
                    Text("\(item.recordedAt): \(item.kind), \(item.status.map(String.init) ?? item.errorCode ?? "unknown")")
                  }
                }.font(.caption).textSelection(.enabled).padding(.vertical, 6)
              }
            }
            DisclosureGroup("Recovery decisions (\(snapshot.operations.count))") {
              ForEach(snapshot.operations) { operation in
                Text("\(operation.action) · \(operation.id)\n\(operation.userId) · \(operation.createdAt)\n\(operation.reason)\n\(operation.completedAt == nil ? "Completion unverified" : "Confirmed complete")")
                  .font(.caption).textSelection(.enabled).padding(.vertical, 6)
              }
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      TextField("Reason for recovery (at least 10 characters)", text: $reason, axis: .vertical)
        .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(busy)
      Toggle("I accept losing unpreserved files and reports when abandoning this sandbox.", isOn: $acknowledgeLoss)
        .disabled(busy)
      Text("A stopped sandbox can still incur storage charges. Deleting this sandbox does not claim to remove independent snapshots, images, or volumes.")
        .font(.caption).foregroundStyle(.secondary)
    }
    .padding(20).frame(width: 680, height: 650)
    .task { await refresh() }
    .confirmationDialog("Permanently abandon sandbox and delete pod?", isPresented: Binding(
      get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
        if let resource = confirmation {
          Button("Abandon and delete", role: .destructive) {
            confirmation = nil
            Task { await submit(resource, action: "abandon") }
          }
        }
        Button("Cancel", role: .cancel) { confirmation = nil }
      } message: {
        Text("Sandbox \(confirmation?.sandboxId ?? "") will be permanently deleted. Unpreserved files and reports may be lost. The pod is removed only if all other custody checks and cleanup succeed. Original wakeup and recovery audit evidence is retained.")
      }
  }

  @ViewBuilder private func resourceCard(_ resource: SandboxRecoveryResource, snapshot: SandboxRecoveryState) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Azure state: \(resource.providerState)").font(.headline)
      Text(resource.sandboxId).font(.caption.monospaced()).textSelection(.enabled)
      Text(resource.resourceKey).font(.caption2).textSelection(.enabled)
      Text("Observed: \(resource.observedAt)").font(.caption).foregroundStyle(.secondary)
      if !resource.pendingIntentIds.isEmpty && resource.abandonment?.completedAt == nil {
        Text("Resume outcome unknown. Elapsed time or Stopped state does not authorize another resume.").foregroundStyle(.orange)
      }
      if let observationError = resource.observationError {
        Text("Provider observation: \(observationError)").font(.caption).foregroundStyle(.orange)
      }
      if let blocked = resource.startBlocked { Text("Start blocked: \(blocked)").font(.caption) }
      if let blocked = resource.abandonBlocked { Text("Abandonment blocked: \(blocked)").font(.caption) }
      HStack {
        Button("Start sandbox for recovery") { Task { await submit(resource, action: "start") } }
          .disabled(!SandboxRecoveryControlPolicy.canStart(resource, reason: reason, busy: busy))
          .accessibilityIdentifier("sandbox-recovery-start")
        Spacer()
        Button(resource.abandonment == nil ? "Abandon and delete…" : "Continue abandonment…", role: .destructive) {
          confirmation = resource
        }
        .disabled(!SandboxRecoveryControlPolicy.canAbandon(resource, currentUserId: snapshot.currentUserId,
          reason: reason, acceptsLoss: acknowledgeLoss, busy: busy))
        .accessibilityIdentifier("sandbox-recovery-abandon")
      }
    }.padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
  }

  private func refresh() async {
    busy = true; error = nil; snapshot = nil
    do {
      let refreshed = try await actions.load(podId)
      snapshot = refreshed
      if let savedRequest, savedRequest.action == "start",
         refreshed.operations.contains(where: { $0.id == savedRequest.id }),
         refreshed.resources.contains(where: { $0.sandboxId == savedRequest.sandboxId && $0.pendingIntentIds.isEmpty }) {
        // A later explicit Start is a new decision only after fresh journal evidence.
        self.savedRequest = nil
      }
    }
    catch DaemonError.notFound { error = "This daemon does not support sandbox recovery, or the pod was removed." }
    catch { self.error = error.localizedDescription }
    busy = false
  }

  private func submit(_ resource: SandboxRecoveryResource, action: String) async {
    guard let snapshot, !busy else { return }
    let proposed: SandboxRecoveryRequest
    if action == "abandon", let abandonment = resource.abandonment,
       abandonment.userId == snapshot.currentUserId {
      proposed = SandboxRecoveryRequest(abandonment: abandonment)
    } else {
      proposed = SandboxRecoveryRequest(action: action, sandboxId: resource.sandboxId,
        expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
        reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
        acknowledgeDataLoss: action == "abandon" && acknowledgeLoss)
    }
    // A lost response keeps the exact submitted identity, not a fresh mutation request.
    let request: SandboxRecoveryRequest
    if let savedRequest, savedRequest.action == proposed.action && savedRequest.sandboxId == proposed.sandboxId && savedRequest.reason == proposed.reason && savedRequest.expectedGeneration == proposed.expectedGeneration && savedRequest.expectedResourceKey == proposed.expectedResourceKey {
      request = savedRequest
    } else { request = proposed; savedRequest = proposed }
    busy = true; error = nil; notice = nil
    do {
      let result = try await actions.submit(podId, request)
      savedRequest = nil
      if result.podDeleted { dismiss(); return }
      notice = result.cleanupError.map { "Sandbox deletion confirmed, but pod cleanup remains blocked: \($0)" }
        ?? (action == "start" ? "Sandbox is running. The coding agent was not started; task status is unchanged." : "Abandonment recorded.")
    } catch {
      self.error = "\(error.localizedDescription) Check status before any further action; a lost response is not proof that the operation failed."
    }
    busy = false
    // Refresh capabilities after both success and failure; never reuse a stale enabled action.
    let priorError = error
    await refresh()
    if let priorError { error = priorError }
  }
}
