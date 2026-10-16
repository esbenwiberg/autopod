import AutopodClient
import AutopodUI
import SwiftUI

/// Explicit fixture mode for native visual review; never wires a daemon or provider.
public struct DesktopDesignPreview: View {
  @State private var selectedID: String? = "retry-demo"
  @State private var showSettings = false
  @State private var connectionManager = ConnectionManager()
  private let onConnect: () -> Void
  public init(onConnect: @escaping () -> Void = {}) { self.onConnect = onConnect }
  public var body: some View {
    MainView(pods: Self.pods, selectedSessionId: $selectedID,
      isConnected: false, connectionLabel: "Design fixtures", connectionState: "Sample data",
      profileNames: MockProfiles.all.map(\.name), profileDetails: MockProfiles.all,
      onShowSettings: { showSettings = true })
      .toolbar {
        ToolbarItem(placement: .principal) {
          Text("Design fixtures · sample data").font(.caption).foregroundStyle(.secondary)
        }
        ToolbarItem(placement: .primaryAction) {
          Button("Connect to a daemon…", action: onConnect).font(.caption)
        }
      }
      .sheet(isPresented: $showSettings) {
        SettingsView(connectionManager: connectionManager, profiles: MockProfiles.all, isPresented: $showSettings)
      }
      .environment(\.controlActiveState, .key)
      .modifier(DesktopAppearanceModifier())
  }

  private static let pods: [Pod] = [
    Pod(id: "retry-demo", status: .validated, branch: "fix/reconnect-retry", profileName: "backend",
        task: "Preserve active work when a daemon connection drops, then resume safely after reconnecting.", model: "Codex", startedAt: Date().addingTimeInterval(-1080),
        diffStats: DiffStats(added: 86, removed: 24, files: 3),
        validationChecks: ValidationChecks(smoke: true, tests: true, review: true), hasWebUi: true,
        phase: PhaseProgress(current: 4, total: 4, description: "Add regression coverage"), costUsd: 1.84, commitCount: 2,
        profileSnapshot: MockProfiles.backend, briefTitle: "Fix retry behaviour on reconnect", seriesId: "resilience", seriesName: "Daemon resilience",
        requireSidecars: ["postgres"], sidecarContainerIds: ["postgres": "fixture-db"], testRunBranches: ["test/reconnect"]),
    Pod(id: "cleanup-demo", status: .failed, branch: "fix/container-cleanup", profileName: "backend", task: "Preserve active allocations while removing orphaned containers.", model: "Claude", startedAt: Date().addingTimeInterval(-1560),
        phase: PhaseProgress(current: 3, total: 9, description: "Verify container cleanup"), errorSummary: "The validation container could not start.", costUsd: 2.16,
        profileSnapshot: MockProfiles.backend, briefTitle: "Repair container cleanup"),
    Pod(id: "input-demo", status: .awaitingInput, branch: "fix/integration-fixture", profileName: "backend", task: "Choose a database fixture and verify the integration workspace.", model: "Codex", startedAt: Date().addingTimeInterval(-720),
        escalationQuestion: "Which database fixture should the agent use?", phase: PhaseProgress(current: 2, total: 3, description: "Choose the database fixture"), costUsd: 0.92,
        profileSnapshot: MockProfiles.backend, briefTitle: "Recover the integration test workspace"),
    Pod(id: "launch-demo", status: .running, branch: "feat/launch-summary", profileName: "my-app", task: "Make repository, model, workflow, and validation choices clear before launch.", model: "Codex", startedAt: Date().addingTimeInterval(-540),
        phase: PhaseProgress(current: 3, total: 4, description: "Build the confirmation view"), costUsd: 0.73,
        profileSnapshot: MockProfiles.myApp, briefTitle: "Polish the profile launch summary"),
    Pod(id: "artifact-demo", status: .running, branch: "fix/artifact-handoff", profileName: "backend", task: "Resume artifact collection after an interrupted connection.", model: "Codex", startedAt: Date().addingTimeInterval(-840),
        plan: SessionPlan(summary: "Recover artifact collection without losing verified outputs.", steps: ["Inspect handoff", "Preserve outputs", "Reconnect collector", "Resume collection", "Handle interrupted downloads", "Check integrity", "Validate sync-back", "Exercise retry paths", "Verify artifacts", "Write summary"]),
        phase: PhaseProgress(current: 3, total: 10, description: "Reconnect the collector"), costUsd: 1.02,
        profileSnapshot: MockProfiles.backend, briefTitle: "Harden artifact collection"),
    Pod(id: "docs-demo", status: .complete, pod: PodConfig(output: .artifact, validate: false), branch: "docs/recovery", profileName: "webapp", task: "Document hosted recovery and verify the runbook links.", model: "Claude", startedAt: Date().addingTimeInterval(-1920),
        phase: PhaseProgress(current: 2, total: 2, description: "Check commands and links"), costUsd: 0.46,
        profileSnapshot: MockProfiles.webapp, briefTitle: "Document hosted daemon recovery"),
    Pod(id: "queued-demo", status: .queued, branch: "audit/schedule-catchup", profileName: "backend", model: "Codex", startedAt: Date().addingTimeInterval(-120),
        profileSnapshot: MockProfiles.backend, briefTitle: "Review schedule catch-up rules"),
    Pod(id: "setup-demo", status: .provisioning, branch: "audit/job-recovery", profileName: "backend", model: "Claude", startedAt: Date().addingTimeInterval(-60),
        profileSnapshot: MockProfiles.backend, briefTitle: "Audit scheduled-job recovery"),
    Pod(id: "merge-demo", status: .merging, branch: "fix/queue-recovery", profileName: "backend", model: "Codex", startedAt: Date().addingTimeInterval(-1260),
        phase: PhaseProgress(current: 4, total: 4, description: "Verify recovery"), costUsd: 1.62,
        profileSnapshot: MockProfiles.backend, briefTitle: "Deliver the queue recovery fix")
  ]
}
