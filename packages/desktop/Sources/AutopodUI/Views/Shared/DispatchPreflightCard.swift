import AutopodClient
import SwiftUI

struct DispatchPreflightCard: View {
  let podId: String
  let actions: PodActions
  @State private var evidence: DispatchPreflightEvidence?
  @State private var environment: ExecutionProvenance?
  @State private var reason = ""
  @State private var pending: IntentionalRerunDraft?
  @State private var busy = false
  @State private var error = ""
  @State private var created: String?
  private var draftKey: String { "autopod.intentional-rerun.\(actions.retryDraftScope).\(podId)" }
  @State private var detailsExpanded: Bool?
  @State private var rerunExpanded = false
  private var blocked: Bool { environment?.status == "blocked" }
  private var showDetails: Binding<Bool> {
    Binding(get: { detailsExpanded ?? blocked }, set: { detailsExpanded = $0 })
  }
  private func memoryLabel(_ bytes: Int?) -> String {
    bytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .memory) } ?? "unverified"
  }
  private func launcherLabel(_ command: ExecutionCommandRequirement) -> String {
    "\(command.source): \(command.executable) · \(command.available.map { $0 ? "available" : "missing" } ?? "unverified")"
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Dispatch preflight").font(.headline)
      if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      // Summary stays visible: status, target, and anything that needs a decision.
      if let evidence {
        Text("\(evidence.status) · \(evidence.repository) · \(evidence.baseBranch)").textSelection(.enabled)
        ForEach(evidence.conflicts) { conflict in
          Text("Equivalent work: \(conflict.podId) · \(conflict.status) · \(conflict.evidence)").textSelection(.enabled)
        }
        if let rerun = evidence.rerun { Text("Intentional rerun of \(rerun.ofPodId): \(rerun.reason)") }
      } else { Text("No dispatch receipt available for this execution.").foregroundStyle(.secondary) }
      if let environment {
        Text("Environment \(environment.status) · \(environment.runtimeLabel) · \(environment.model)")
          .foregroundStyle(blocked ? .red : .primary)
        if blocked {
          ForEach(Array(environment.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
            Text(diagnostic.detail).foregroundStyle(.red).textSelection(.enabled)
          }
        }
      } else { Text("No execution environment receipt available.").foregroundStyle(.secondary) }
      // Raw provenance is audit evidence, not working information. Collapsed
      // unless the environment is blocked.
      DisclosureGroup("Execution details", isExpanded: showDetails) {
        VStack(alignment: .leading, spacing: 6) {
          if let evidence {
            Text("Admitted \(evidence.checkedAt)")
            Text("Fresh base: \(evidence.baseCommitSha)").textSelection(.enabled)
          }
          if let environment {
            Text("\(environment.purpose ?? "coding") preflight \(environment.status) · generation \(environment.generation) · \(environment.checkedAt)")
            Text("\(environment.subjectLabel): \(environment.runtimeLabel) · \(environment.model)")
            if environment.surface == "host-cli" { Text("Executable: \(environment.cliPath ?? "unverified")").textSelection(.enabled) }
            Text("Provider: \(environment.providerId ?? "unverified") · account: \(environment.providerAccountId ?? "not recorded")")
            Text("Daemon: \(environment.release.commitSha ?? "unverified")\(environment.release.dirty == true ? " · modified source" : "")").textSelection(.enabled)
            Text("Image: \(environment.imageLabel)").textSelection(.enabled)
            Text("Validation implementation: \(environment.validationImplementationHash ?? "unverified")").textSelection(.enabled)
            Text("Contract: \(environment.contractHash)").textSelection(.enabled)
            Text("Memory: \(memoryLabel(environment.capabilities.memoryLimitBytes)) · CPU: \(environment.capabilities.cpuLimit.map { String($0) } ?? "unverified")")
            ForEach(Array(environment.commands.requirements.enumerated()), id: \.offset) { _, command in
              Text(launcherLabel(command))
            }
            if !blocked {
              ForEach(Array(environment.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                Text(diagnostic.detail).foregroundStyle(.secondary)
              }
            }
          }
          Button("Refresh dispatch evidence") { Task { await refresh() } }.disabled(busy)
        }.font(.caption).padding(.top, 4)
      }
      if let created { Text("Distinct execution created: \(created). Inspect its preflight and execution outcome.").textSelection(.enabled) }
      else {
        DisclosureGroup("Intentional rerun", isExpanded: Binding(get: { rerunExpanded || pending != nil }, set: { rerunExpanded = $0 })) {
          VStack(alignment: .leading, spacing: 8) {
            Text("Intentionally repeating this request creates a distinct task and may run a coding agent. Fresh contract, provider, and environment checks still apply.")
              .font(.caption).foregroundStyle(.secondary)
            TextField("Reason for intentional rerun", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).disabled(busy || pending != nil)
            Button(pending == nil ? "Create intentional rerun" : "Retry the same rerun request") { Task { await rerun() } }
              .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }.padding(.top, 4)
        }
      }
    }.padding(16).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
      .task(id: podId) {
        evidence = nil; environment = nil; pending = nil; reason = ""; error = ""; created = nil; detailsExpanded = nil; rerunExpanded = false
        if let data = UserDefaults.standard.data(forKey: draftKey) {
          do { let draft = try JSONDecoder().decode(IntentionalRerunDraft.self, from: data); pending = draft; reason = draft.intentionalRerun?.reason ?? "" }
          catch { self.error = "Saved rerun request is unreadable." }
        }
        await refresh()
      }
  }
  private func refresh() async {
    do { evidence = try await actions.loadDispatchPreflight(podId).latest; environment = try await actions.loadExecutionProvenance(podId).latest; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func rerun() async {
    busy = true; defer { busy = false }
    do {
      var draft: IntentionalRerunDraft
      if let pending { draft = pending }
      else {
        draft = try await actions.loadRerunTemplate(podId)
        draft.intentionalRerun = IntentionalRerunRequest(ofPodId: podId, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), requestKey: UUID().uuidString)
      }
      UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: draftKey); pending = draft
      created = try await actions.createIntentionalRerun(draft)
      UserDefaults.standard.removeObject(forKey: draftKey); pending = nil
      error = ""
    } catch { self.error = error.localizedDescription }
  }
}
