import AutopodClient
import SwiftUI

struct PodGoalCard: View {
  let podId: String
  let podStatus: String
  let actions: PodActions
  @State private var goal: PodGoalResponse?
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    Group {
      if let goal {
        GroupBox {
          VStack(alignment: .leading, spacing: 10) {
            HStack {
              Label("Native Goal", systemImage: "target").font(.headline)
              Spacer()
              Text(goal.state.replacingOccurrences(of: "-", with: " ").capitalized)
                .foregroundStyle(.secondary)
            }
            Text(goal.objective).textSelection(.enabled)
            Text("\(goal.observedTokens) tokens, including goal evaluation")
              .font(.caption).foregroundStyle(.secondary)
            if let intent = goal.controlIntent {
              Text("\(intent.capitalized) requested").font(.caption)
            }
            if let reason = goal.reason { Text(reason).font(.callout) }
            if goal.state == "achieved" {
              Text("Goal achieved. AutoPod validation and delivery still apply.")
                .font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            HStack {
              if goal.state == "active" && !goal.executionStopped {
                Button("Pause") { control("pause", goal: goal) }
              }
              if goal.executionStopped && ["paused", "failed", "blocked", "budget-exhausted"].contains(goal.state)
                && ["paused", "failed"].contains(podStatus) {
                Button("Resume") { control("resume", goal: goal) }
              }
              if !["achieved", "cancelled", "failed"].contains(goal.state) {
                Button("Cancel Goal", role: .destructive) { control("cancel", goal: goal) }
              }
              Spacer()
              Button("Refresh") { Task { await refresh() } }
            }
            .disabled(busy || goal.controlIntent != nil)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(6)
        }
      }
    }
    .task(id: podId) {
      goal = nil
      error = nil
      await refresh()
      while !Task.isCancelled && goal != nil {
        do { try await Task.sleep(for: .seconds(3)) } catch { return }
        if !busy { await refresh() }
      }
    }
  }

  private func refresh() async {
    do {
      goal = try await actions.loadGoal(podId)
    } catch {
      if goal != nil { self.error = error.localizedDescription }
    }
  }

  private func control(_ intent: String, goal: PodGoalResponse) {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        self.goal = try await actions.controlGoal(podId, .init(revision: goal.revision, intent: intent))
      } catch {
        self.error = error.localizedDescription
        await refresh()
      }
    }
  }
}
