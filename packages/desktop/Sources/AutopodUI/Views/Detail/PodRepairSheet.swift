import AutopodClient
import SwiftUI

internal struct PodRepairSheet: View {
  @Binding var isPresented: Bool
  let pod: Pod
  let relatedPods: [Pod]
  let actions: PodActions
  var configuration: LaunchConfigurationActions?
  var onSelect: ((String) -> Void)?
  @State private var model: PodRepairModel
  @State private var snapshot: EffectiveLaunchPreview?
  @State private var snapshotError: String?
  @State private var goalBlocked = false
  @State private var confirmClose = false
  @State private var confirmRepeat = false
  init(isPresented: Binding<Bool>, pod: Pod, kind: PodRepairKind, relatedPods: [Pod], actions: PodActions,
    configuration: LaunchConfigurationActions? = nil, onSelect: ((String) -> Void)? = nil, model: PodRepairModel? = nil) {
    self._isPresented = isPresented; self.pod = pod; self.relatedPods = relatedPods; self.actions = actions
    self.configuration = configuration; self.onSelect = onSelect; self._model = State(initialValue: model ?? PodRepairModel(kind: kind, scope: actions.repair.scope))
  }
  private var observed: Pod { model.observation?.source ?? pod }
  private var repository: String? {
    if let id = snapshot?.fields["repository"]?["id"]?.string {
      return configuration?.list(.repository).first { $0.id == id }?.name
        ?? snapshot?.fields["repository"]?["config"]?["remote"]?.string.flatMap { DesktopRepository(url: $0)?.label } ?? id
    }
    return DesktopRepository.resolve(observed, profiles: [])?.label
  }
  private var owner: Pod? {
    if observed.prUrl != nil { return observed }
    guard snapshot?.fields["work"]?["prMode"]?.string == "single" else { return nil }
    return (model.observation?.related ?? relatedPods).first { $0.seriesId == observed.seriesId && $0.prUrl != nil }
  }
  private var block: String? {
    if observed.worktreeCompromised && model.kind != .prFix { return "Recover the compromised worktree before continuing." }
    if model.kind == .rework && goalBlocked { return "The native Goal must be achieved and stopped. Continue through the pod’s Goal controls." }
    if (model.kind == .resume || (model.kind == .rework && observed.isWorkspace)) && !observed.hasWorktree { return "This pod has no worktree to recover." }
    if model.kind == .manual && ![.failed, .reviewRequired, .validated].contains(observed.status) { return "Manual repair is available for failed, review-required or validated workers." }
    return nil
  }
  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 7) {
          Text("POD / REPAIR HANDOFF").font(.caption2).tracking(1.2).foregroundStyle(.secondary)
          Text(title).font(.title.weight(.semibold))
          Text("Review the effect before continuing.").font(.callout).foregroundStyle(.secondary)
        }
        Spacer(); Button("Close", systemImage: "xmark", action: close).disabled(model.busy).keyboardShortcut(.cancelAction)
      }.padding(24).background(DesktopTheme.surface)
      Divider(); FollowUpSourceContext(pod: observed, repository: repository); Divider()
      HStack(spacing: 0) {
        ScrollView { content.padding(28).frame(maxWidth: .infinity, alignment: .topLeading) }
        Divider()
        ScrollView { summary.padding(22) }.frame(width: 270).background(DesktopTheme.sidebar)
      }
      Divider(); footer.padding(18).background(DesktopTheme.surface)
    }.background(DesktopTheme.canvas).tint(DesktopTheme.accent)
      .frame(minWidth: 900, idealWidth: 1120, minHeight: 650, idealHeight: 800)
      .task { await loadSnapshot() }
      .interactiveDismissDisabled(model.busy || model.uncertain || !model.feedback.isEmpty)
      .confirmationDialog("Leave this repair handoff?", isPresented: $confirmClose) {
        Button("Leave handoff", role: .destructive) { isPresented = false }; Button("Keep reviewing", role: .cancel) {}
      } message: { Text(model.uncertain ? "The result is unconfirmed. Check the pod and linked work before repeating the action." : "Your unsubmitted feedback will be discarded.") }
      .confirmationDialog("Review another attempt?", isPresented: $confirmRepeat) {
        Button("Review another attempt", role: .destructive) { model.reviewAnotherAttempt() }; Button("Keep checking", role: .cancel) {}
      } message: { Text("The earlier action may already have been accepted. Another submission can duplicate work or PR feedback. Inspect observed state first.") }
  }
  private var title: String { model.kind == .rework && observed.isWorkspace ? "Restart workspace" : model.kind.title }
  @ViewBuilder private var content: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 20) {
      if model.uncertain {
        Label("Result unconfirmed", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        Text("Check the latest state before repeating.").font(.title2.weight(.semibold))
        Text("This control endpoint has no durable launch retry identity. Refresh the pod and inspect linked work or feedback before making another attempt.").foregroundStyle(.secondary)
      } else if let receipt = model.receipt {
        Label("Request accepted", systemImage: "checkmark.circle").font(.title2).foregroundStyle(DesktopTheme.accent)
        Text(receipt.message).textSelection(.enabled)
        if let count = receipt.unreadFeedback { Text("\(count) unread feedback message\(count == 1 ? "" : "s")").font(.headline); Text("This is a backlog count, not a queue position or repair completion.").font(.caption).foregroundStyle(.secondary) }
        if let id = receipt.podID { Button(model.kind == .manual ? "Open linked workspace" : "Open fix pod") { onSelect?(id); isPresented = false }.accessibilityIdentifier("repair-open-result") }
      } else {
        if [.rework, .revalidate, .resume].contains(model.kind), !observed.isWorkspace {
          HStack { ForEach([PodRepairKind.rework, .revalidate, .resume]) { kind in
            Button(kind.title) { model.kind = kind }.buttonStyle(.bordered).tint(model.kind == kind ? DesktopTheme.accent : .secondary)
              .accessibilityIdentifier("repair-kind-\(kind.rawValue)")
          } }.disabled(model.busy)
        }
        Text(explanation).font(.title3.weight(.medium))
        VStack(alignment: .leading, spacing: 12) {
          Text(model.kind == .manual ? "NEW LINKED WORKSPACE / SAME BRANCH" : model.kind == .prFix ? "PR REPAIR / OWNER BRANCH" : "SAME POD / \(observed.id)").font(.caption2).foregroundStyle(DesktopTheme.accent)
          Text(model.kind == .prFix ? owner?.branch ?? "Daemon resolves PR owner" : observed.branch).font(.headline).textSelection(.enabled)
          Text(effect).font(.callout).foregroundStyle(.secondary)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(DesktopTheme.selection, in: RoundedRectangle(cornerRadius: 7))
        if model.kind == .prFix {
          if let owner {
            Text("Triggered by \(observed.id) · PR owner \(owner.id)").font(.caption)
            if let url = owner.prUrl { Link("Open owning PR", destination: url) }
            Text("Base / target: \(owner.baseBranch ?? "repository default")").font(.caption).foregroundStyle(.secondary)
          } else { Text("The daemon verifies the PR owner before admitting repair. The triggering pod may not own the PR branch.").font(.caption).foregroundStyle(.secondary) }
          Text("Reviewer comments or repair instructions · optional").font(.headline)
          TextEditor(text: $model.feedback).font(.body).scrollContentBackground(.hidden).frame(minHeight: 150)
            .padding(12).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 6)).accessibilityIdentifier("repair-feedback").disabled(model.busy)
          Text("Leave blank to auto-detect CI failures and PR review comments. Feedback may join an existing fix pod.").font(.caption).foregroundStyle(.secondary)
        }
        if let block { Label(block, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
      }
      if let observation = model.observation {
        Divider(); Text("Observed state · \(observation.source.status.label)").font(.headline)
        Text(observation.source.latestActivity ?? "No recent activity supplied.").font(.callout).foregroundStyle(.secondary)
        ForEach(observation.related.filter { $0.linkedSessionId == pod.id || $0.id == observation.source.fixPodId }) { related in
          HStack { Text("\(related.id) · \(related.status.label)"); Spacer(); Button("Open pod") { onSelect?(related.id); isPresented = false } }
        }
        if model.kind == .prFix { Text("\(observation.source.queueLength) unread feedback messages. This does not prove whether this particular message was accepted.").font(.caption).foregroundStyle(.secondary) }
      }
      DisclosureGroup("Inspect source configuration · read-only") {
        if let snapshot { FollowUpFrozenConfiguration(source: snapshot) }
        else { Text(snapshotError ?? "Loading source snapshot…").font(.caption).foregroundStyle(.secondary); Button("Reload snapshot") { Task { await loadSnapshot() } } }
      }
      if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
    }
  }
  private var explanation: String {
    switch model.kind {
    case .manual: "A workspace for your repair."
    case .rework: observed.isWorkspace ? "Bring the workspace back." : "Let the agent rework this task."
    case .revalidate: "Validate the latest code without running an agent."
    case .resume: "Continue through the cheapest recovery path."
    case .prFix: "Send the next repair a clear brief."
    }
  }
  private var effect: String {
    switch model.kind {
    case .manual: "You make the repair in an interactive workspace on the source branch. No autonomous agent starts. After successful push, completion revalidates a linked worker when it is failed or review required."
    case .rework: observed.isWorkspace ? "A new container attaches to the existing worktree. No autonomous agent starts." : "Keep the pod identity and existing task. An agent may run again and spend tokens. Execution safety and native Goal checks still apply."
    case .revalidate: "Run validation on the latest code. The request receipt is separate from the validation result."
    case .resume: "Continue push and PR work when checks passed; otherwise use validation-only recovery. No agent rework."
    case .prFix: "Use the PR-owning branch. The daemon may create or reuse a fix pod; acceptance of feedback is separate from repair progress."
    }
  }
  private var summary: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("HANDOFF SUMMARY").font(.caption2).tracking(1.2).foregroundStyle(.secondary)
      Text(model.uncertain ? "Result unconfirmed" : model.receipt != nil ? "Request accepted" : "Ready for review").font(.caption).foregroundStyle(DesktopTheme.accent)
      Text(title).font(.headline); Divider()
      Text(repository ?? "Repository unavailable").font(.callout)
      Text("Source \(observed.id)").font(.caption).foregroundStyle(.secondary)
      Text(model.kind == .manual ? "New linked interactive pod" : model.kind == .prFix ? "New or existing fix pod" : "Same pod identity").font(.callout)
      Divider(); Text("Acceptance and execution are separate. Follow observed pod state after the handoff.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private var footer: some View {
    HStack {
      if model.busy { ProgressView().controlSize(.small) }
      Text(model.uncertain ? "Check state before repeating" : model.receipt != nil ? "Receipt retained" : "Review the effect before continuing").font(.caption).foregroundStyle(.secondary)
      Spacer()
      if model.uncertain || model.receipt != nil {
        if model.uncertain && model.observation != nil { Button("Review another attempt") { confirmRepeat = true }.disabled(model.busy) }
        Button("Check latest state") { Task { await model.inspect(id: pod.id, actions: actions.repair) } }.disabled(model.busy)
          .accessibilityIdentifier("repair-inspect")
      } else {
        Button(title) { Task { await model.submit(id: pod.id, actions: actions.repair) } }.buttonStyle(.borderedProminent)
          .disabled(model.busy || block != nil).accessibilityIdentifier("repair-submit")
      }
    }
  }
  private func close() { if model.uncertain || (!model.feedback.isEmpty && model.receipt == nil) { confirmClose = true } else { isPresented = false } }
  private func loadSnapshot() async {
    guard let configuration else { snapshotError = "Frozen configuration is unavailable for this connection."; return }
    do {
      snapshot = try await configuration.readLaunch(pod.id); snapshotError = nil
      if snapshot?.intent == "goal" {
        goalBlocked = true
        let goal = try await actions.loadGoal(pod.id)
        goalBlocked = goal?.state != "achieved" || goal?.executionStopped != true
      }
    } catch { snapshotError = error.localizedDescription }
  }
}
