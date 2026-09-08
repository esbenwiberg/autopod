import AutopodClient
import SwiftUI

struct TaskRetryCard: View {
  let podId: String
  let status: String
  let actions: PodActions
  var stage: String = "validation"
  @State private var state: TaskRetryState?
  @State private var reason = ""
  @State private var pending: TaskRetryAuthorizationRequest?
  @State private var busy = false
  @State private var error = ""
  @State private var message = ""
  private var draftKey: String {
    "autopod.retry-authorization.\(actions.retryDraftScope).\(podId)"
      + (stage == "validation" ? "" : ".\(stage)")
  }
  private var stageLabel: String { stage == "codex_interruption" ? "Codex interruption recovery" : stage == "validation" ? "Validation" : stage == "worker" ? "Worker" : "Sandbox startup" }
  var body: some View {
    Group {
      if stage == "validation" || (state?.admissionCount ?? 0) > 0 || !error.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          Text(stage == "codex_interruption" ? "Codex recovery allowance" : stage == "worker" ? "Worker execution" : "\(stageLabel) retry budget").font(.headline)
          if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
          if !message.isEmpty { Text(message).textSelection(.enabled) }
          if let state {
            Text(
              "\(state.executedCount) executed / \(state.admissionCount) admitted \(stage == "codex_interruption" ? "Codex interruption recoveries" : stage == "validation" ? "validations" : stage == "worker" ? "worker runs" : "sandbox startups") across this task"
            )
            Text(
              (stage == "codex_interruption") ? "\(state.measuredDurationMs) ms measured" : "\(state.transientRetryCount) / \(state.backoffsMs?.count ?? 0) \(stage == "worker" ? "transient retry admissions" : "automatic transient retries") · \(state.measuredDurationMs) ms measured"
            )
            Text(
              "\(state.interruptedCount) interrupted with unknown duration · \(state.telemetry) telemetry"
            )
            if stage == "codex_interruption" { Text("One automatic inner recovery per logical task; further recoveries require recorded human authorization. Duration overlaps the enclosing agent run; usage is not counted again.") }
            if stage == "worker" { Text("Repeated worker failures with unknown causes or rejected authentication require a recorded human authorization. Classified throttling and provider outages use the persisted task allowance and cooldown. Worker elapsed time overlaps phase measurements; usage is not counted again.") }
            Text("Latest outcome: \(state.latest?.outcome ?? "none")")
            ForEach(state.authorizations) { grant in
              Text(
                "\(grant.usedByAttemptId != nil ? "Consumed" : grant.failureId == state.latest?.id ? (stage == "codex_interruption" ? "Available for latest recovery" : "Available for latest failure") : "Superseded"): \(grant.reason)"
              ).font(.caption)
            }
            if let outcome = state.latest?.outcome, (stage == "worker" ? state.authorizationRequired == true || state.retryFailure == "transient" : outcome != "pass" || stage == "codex_interruption"),
              status == "failed" || status == "review_required"
            {
              if stage != "worker" || state.authorizationRequired == true || pending != nil {
              TextField("Reason for one extra retry", text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder).disabled(busy || pending != nil)
              Button(
                pending == nil
                  ? "Record one retry authorization" : "Retry recording the same authorization"
              ) { Task { await record() } }
              .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              }
              Button(stage == "codex_interruption" ? "Resume task" : stage == "validation" ? "Resume validation" : stage == "worker" ? "Rework worker" : "Resume sandbox startup") {
                Task {
                  busy = true
                  error = ""
                  message = ""
                  defer { busy = false }
                  do {
                    if stage == "worker" { try await actions.reworkRetry(podId) }
                    else { try await actions.resumeRetry(podId) }
                    await refresh()
                    message =
                      "\(stage == "worker" ? "Rework" : "Resume") requested. Refresh to inspect admission and execution outcome."
                  } catch { self.error = error.localizedDescription }
                }
              }.disabled(busy)
            }
          }
          Button("Refresh retry accounting") { Task { await refresh() } }.disabled(busy)
        }.padding(16).background(Color(nsColor: .controlBackgroundColor)).clipShape(
          RoundedRectangle(cornerRadius: 10))
      }
    }
    .task(id: "\(podId).\(stage).\(status)") {
      state = nil
      pending = nil
      reason = ""
      error = ""
      message = ""
      if let data = UserDefaults.standard.data(forKey: draftKey) {
        do {
          let draft = try JSONDecoder().decode(TaskRetryAuthorizationRequest.self, from: data)
          pending = draft
          reason = draft.reason
        } catch { self.error = "Saved retry draft is unreadable." }
      }
      await refresh()
    }
  }
  private func refresh() async {
    do {
      state = try await actions.loadRetryState(podId, stage)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  private func record() async {
    busy = true
    defer { busy = false }
    do {
      let draft =
        pending
        ?? TaskRetryAuthorizationRequest(
          requestKey: UUID().uuidString,
          reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
          stage: stage == "validation" ? nil : stage)
      UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: draftKey)
      pending = draft
      _ = try await actions.authorizeRetry(podId, draft)
      UserDefaults.standard.removeObject(forKey: draftKey)
      pending = nil
      reason = ""
      await refresh()
      message = "One retry authorization recorded. \(stage == "worker" ? "Rework" : "Resume") is a separate action."
    } catch { self.error = error.localizedDescription }
  }
}
