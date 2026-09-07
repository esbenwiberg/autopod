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
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Dispatch preflight").font(.headline)
      if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      if let evidence {
        Text("\(evidence.status) · \(evidence.checkedAt)")
        Text("\(evidence.repository) · \(evidence.baseBranch)").textSelection(.enabled)
        Text("Fresh base: \(evidence.baseCommitSha)").font(.caption).textSelection(.enabled)
        ForEach(evidence.conflicts) { conflict in
          Text("Equivalent work: \(conflict.podId) · \(conflict.status) · \(conflict.evidence)").textSelection(.enabled)
        }
        if let rerun = evidence.rerun { Text("Intentional rerun of \(rerun.ofPodId): \(rerun.reason)") }
      } else { Text("No dispatch receipt available for this execution.") }
      Text("Execution environment").font(.headline)
      if let environment {
        Text("\(environment.purpose ?? "coding") preflight \(environment.status) · generation \(environment.generation) · \(environment.checkedAt)")
        Text("Configured worker: \(environment.runtime) CLI \(environment.cliVersion ?? "unverified") · \(environment.model)")
        Text("Daemon: \(environment.release.commitSha ?? "unverified")\(environment.release.dirty == true ? " · modified source" : "")").textSelection(.enabled)
        Text("Image: \(environment.imageDigest ?? "unverified")").font(.caption).textSelection(.enabled)
        Text("Validation implementation: \(environment.validationImplementationHash ?? "unverified")").font(.caption).textSelection(.enabled)
        Text("Contract: \(environment.contractHash)").font(.caption).textSelection(.enabled)
        Text("Memory: \(environment.capabilities.memoryLimitBytes.map(String.init) ?? "unverified") bytes · CPU: \(environment.capabilities.cpuLimit.map { String($0) } ?? "unverified")")
        ForEach(Array(environment.commands.requirements.enumerated()), id: \.offset) { _, command in
          Text("\(command.source): \(command.executable) · \(command.available.map { $0 ? "available" : "missing" } ?? "unverified")")
        }
        ForEach(Array(environment.diagnostics.enumerated()), id: \.offset) { _, diagnostic in Text(diagnostic.detail) }
      } else { Text("No execution environment receipt available.") }
      if let created { Text("Distinct execution created: \(created). Inspect its preflight and execution outcome.").textSelection(.enabled) }
      else {
        Text("Intentionally repeating this request creates a distinct task and may run a coding agent. Fresh contract, provider, and environment checks still apply.")
        TextField("Reason for intentional rerun", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).disabled(busy || pending != nil)
        Button(pending == nil ? "Create intentional rerun" : "Retry the same rerun request") { Task { await rerun() } }
          .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      Button("Refresh dispatch evidence") { Task { await refresh() } }.disabled(busy)
    }.padding(16).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
      .task(id: podId) {
        evidence = nil; environment = nil; pending = nil; reason = ""; error = ""; created = nil
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
    } catch { self.error = error.localizedDescription }
  }
}
