import AutopodClient
import SwiftUI

struct TaskRetryCard: View {
  let podId: String
  let status: String
  let actions: PodActions
  @State private var state: TaskRetryState?
  @State private var reason = ""
  @State private var pending: TaskRetryAuthorizationRequest?
  @State private var busy = false
  @State private var error = ""
  @State private var message = ""
  private var draftKey: String { "autopod.retry-authorization.\(actions.retryDraftScope).\(podId)" }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Validation retry budget").font(.headline)
      if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      if !message.isEmpty { Text(message).textSelection(.enabled) }
      if let state {
        Text("\(state.executedCount) executed / \(state.admissionCount) admitted validations across this task")
        Text("\(state.transientRetryCount) / \(state.backoffsMs?.count ?? 0) automatic transient retries · \(state.measuredDurationMs) ms measured")
        Text("\(state.interruptedCount) interrupted with unknown duration · \(state.telemetry) telemetry")
        Text("Latest outcome: \(state.latest?.outcome ?? "none")")
        ForEach(state.authorizations) { grant in
          Text("\(grant.usedByAttemptId != nil ? "Consumed" : grant.failureId == state.latest?.id ? "Available for latest failure" : "Superseded"): \(grant.reason)").font(.caption)
        }
        if let outcome = state.latest?.outcome, outcome != "pass", status == "failed" || status == "review_required" {
          TextField("Reason for one extra retry", text: $reason, axis: .vertical)
            .textFieldStyle(.roundedBorder).disabled(busy || pending != nil)
          Button(pending == nil ? "Record one retry authorization" : "Retry recording the same authorization") { Task { await record() } }
            .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Button("Resume validation") { Task {
            busy = true
            await actions.resume(podId)
            await refresh()
            message = "Resume requested. Refresh to inspect admission and execution outcome."
            busy = false
          } }.disabled(busy)
        }
      }
      Button("Refresh retry accounting") { Task { await refresh() } }.disabled(busy)
    }.padding(16).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
      .task(id: podId) {
        state = nil; pending = nil; reason = ""; error = ""; message = ""
        if let data = UserDefaults.standard.data(forKey: draftKey) {
          do { let draft = try JSONDecoder().decode(TaskRetryAuthorizationRequest.self, from: data); pending = draft; reason = draft.reason }
          catch { self.error = "Saved retry draft is unreadable." }
        }
        await refresh()
      }
  }
  private func refresh() async {
    do { state = try await actions.loadRetryState(podId); error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func record() async {
    busy = true; defer { busy = false }
    do {
      let draft = pending ?? TaskRetryAuthorizationRequest(requestKey: UUID().uuidString, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
      UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: draftKey); pending = draft
      _ = try await actions.authorizeRetry(podId, draft)
      UserDefaults.standard.removeObject(forKey: draftKey); pending = nil; reason = ""
      await refresh()
      message = "One retry authorization recorded. Resume validation is a separate action."
    } catch { self.error = error.localizedDescription }
  }
}
