import AutopodClient
import AutopodUI
import SwiftUI

/// Explicit fixture mode for native visual review; never wires a daemon or provider.
public struct DesktopDesignPreview: View {
  @State private var knowledge = DesktopKnowledgeFixtures()
  @State private var scheduleFixtures = DesktopScheduleFixtures()
  @State private var usePerformanceFleet = false
  @State private var performanceSelectedID: String? = "perf-0000"
  @State private var simulateAnalyticsFailure = false
  @State private var scanFixtures = DesktopScanFixtures()
  @State private var selectedID: String? = "retry-demo"
  @State private var showSettings = false
  @State private var configurationDocuments = DesktopConfigurationFixtures.documents
  @State private var simulateConfigurationConflict = false
  @State private var connectionManager = ConnectionManager(restoreConnection: false)
  private let onConnect: () -> Void
  public init(onConnect: @escaping () -> Void = {}) { self.onConnect = onConnect }
  public var body: some View {
    Group {
      if usePerformanceFleet {
        DesktopPerformanceFixtures.mainView(selection: $performanceSelectedID)
      } else {
    MainView(pods: Self.pods, managedPods: DesktopKnowledgeFixtures.managedPods, managedPodAPI: knowledge.api, selectedManagedPodId: $knowledge.selectedManagedID, scheduledJobs: scheduleFixtures.jobs, scheduledJobTemplates: scheduleFixtures.templates, selectedSessionId: $selectedID,
      isConnected: true, connectionLabel: "Design fixtures", connectionState: "Sample data",
      actions: Self.fixtureActions,
      profileNames: MockProfiles.all.map(\.name), profileDetails: MockProfiles.all,
      configurationActions: configurationActions,
      selectedSessionEvents: selectedID == "retry-demo" ? Self.events : [],
      eventsForPod: { $0 == "retry-demo" ? Self.events : [] },
      sessionDiffs: ["retry-demo": Self.fixtureDiff],
      onShowSettings: { showSettings = true },
      settingsWorkspace: { route in
        AnyView(
          SettingsView(
            connectionManager: connectionManager, profiles: MockProfiles.all,
            configurationActions: configurationActions, isPresented: $showSettings,
            embedded: true, initialRoute: route))
      },
      loadFiles: { _ in Self.fixtureFiles }, loadArtifacts: { _ in Self.fixtureFiles },
      loadContent: { _, path in SessionFileContent(path: path, content: "# Recovery review\n\nSaved checkpoint restored before reconnecting.\n\n- No repeated side effects\n- Regression checks recorded", size: 130) },
      loadQuality: { id in Self.fixtureQuality(id) },
      loadCost: { id in PodCostBreakdownResponse(podId: id, model: "Codex", totalCostUsd: 1.84, inputTokens: 12000, outputTokens: 3400, segments: [PodCostSegment(bucket: "work", label: "Implementation", costUsd: 1.52, inputTokens: 10000, outputTokens: 2800, sourcePhases: ["worker"]), PodCostSegment(bucket: "validation", label: "Validation", costUsd: 0.32, inputTokens: 2000, outputTokens: 600, sourcePhases: ["review"])]) },
      loadValidationHistory: { _ in Self.validationHistory },
      loadCostAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.cost(days) },
      loadReliabilityAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.reliability(days) },
      loadQualityAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.quality(days) },
      loadSafetyAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.safety(days) },
      loadThroughputAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.throughput(days) },
      loadEscalationsAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.escalations(days) },
      loadModelsAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.models(days) },
      loadMemoryAnalytics: { days in if simulateAnalyticsFailure { throw DaemonError.badRequest("Fictional analytics load failure") }; return try DesktopAnalyticsFixtures.memory(days) },
      verifyAuditChain: { try DesktopAnalyticsFixtures.verify() },
      scheduledWorkspaceActions: scheduleFixtures.actions,
      scanWorkspace: { job, presented in
        AnyView(ScanInboxView(job: job, api: scanFixtures, embedded: true, onClose: { presented.wrappedValue = false }))
      },
      memoryEntries: knowledge.entries, activeMemories: knowledge.entries.filter(\.approved),
      pendingMemoryCandidates: knowledge.candidates, memoryExtractionAttempts: DesktopKnowledgeFixtures.attempts,
      selectedMemoryUsage: knowledge.selectedMemoryID.map { DesktopKnowledgeFixtures.usage($0) } ?? [],
      selectedMemorySourceEvidence: DesktopKnowledgeFixtures.evidence,
      selectedMemoryStaleEvidence: knowledge.selectedMemoryID == "setup-note" ? DesktopKnowledgeFixtures.usage("setup-note").filter { $0.outcome == .harmfulStale } : [],
      selectedMemoryDetailId: knowledge.selectedMemoryID, selectedMemoryCandidateDetailId: knowledge.selectedCandidateID,
      pendingMemoryCount: knowledge.candidates.count + knowledge.entries.filter { !$0.approved }.count,
      onApproveMemory: { knowledge.approve($0) }, onRejectMemory: { id in knowledge.entries.removeAll { $0.id == id } },
      onDeleteMemory: { id in knowledge.entries.removeAll { $0.id == id } },
      onApproveMemoryCandidate: { knowledge.approveCandidate($0) }, onRejectMemoryCandidate: { id in knowledge.candidates.removeAll { $0.id == id } },
      onSelectMemory: { knowledge.selectedMemoryID = $0; knowledge.selectedCandidateID = nil },
      onSelectMemoryCandidate: { knowledge.selectedCandidateID = $0; knowledge.selectedMemoryID = nil },
      memoryWorkspaceActions: knowledge.actions)
      }
    }
      .toolbar {
        ToolbarItem(placement: .principal) {
        HStack {
          Text("Design fixtures · sample data").font(.caption)
          Menu("Fixture options") {
            Toggle("Use 1,000 pod performance fixture", isOn: $usePerformanceFleet)
              .onChange(of: usePerformanceFleet) { _, _ in performanceSelectedID = "perf-0000" }
            Toggle("Simulate configuration save conflict", isOn: $simulateConfigurationConflict)
            Toggle("Simulate schedule save failure", isOn: $scheduleFixtures.failWrites)
            Toggle("Simulate memory save failure", isOn: $knowledge.failWrites)
            Toggle("Simulate analytics load failure", isOn: $simulateAnalyticsFailure)
          }.menuStyle(.borderlessButton).fixedSize()
        }.foregroundStyle(.secondary)
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

  private var configurationActions: LaunchConfigurationActions {
    let unavailable = DaemonError.badRequest("This fixture has no daemon or provider connection.")
    var actions = LaunchConfigurationActions(
      documents: configurationDocuments, capabilities: DesktopConfigurationFixtures.capabilities,
      reload: {}, resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
      save: { kind, request in
        let id = request.id ?? UUID().uuidString
        let existing = configurationDocuments.first { $0.id == id }
        if simulateConfigurationConflict, let existing {
          let newer = try DesktopConfigurationFixtures.document(
            kind, id: id, name: existing.name,
            payload: existing.payload, revision: existing.revision + 1)
          configurationDocuments.removeAll { $0.id == id }; configurationDocuments.append(newer)
          throw DaemonError.serverError(
            409, "A newer configuration revision was saved. Your draft has been retained.")
        }
        guard existing?.revision == request.expectedRevision else {
          throw DaemonError.serverError(409, "The saved revision changed.")
        }
        let saved = try DesktopConfigurationFixtures.document(
          kind, id: id, name: request.name,
          payload: request.payload, revision: (existing?.revision ?? 0) + 1)
        configurationDocuments.removeAll { $0.id == id }; configurationDocuments.append(saved)
        return saved
      }, archive: { item in configurationDocuments.removeAll { $0.id == item.id } },
      discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { DesktopConfigurationFixtures.accounts },
      discoverPim: { _ in throw unavailable },
      saveFromLaunch: { _ in throw unavailable }, listWatchers: { [] })
    actions.listDeployments = { [] }
    return actions
  }

  private static func decodeFixture<T: Decodable>(_ type: T.Type, _ json: String) -> T {
    do { return try JSONDecoder().decode(type, from: Data(json.utf8)) }
    catch { preconditionFailure("Invalid desktop design fixture: \(error)") }
  }

  private static var fixtureActions: PodActions {
    var actions = PodActions.preview
    actions.loadDispatchPreflight = { _ in decodeFixture(DispatchPreflightResponse.self, #"{"latest":null}"#) }
    actions.loadExecutionProvenance = { _ in decodeFixture(ExecutionProvenanceResponse.self, #"{"latest":null}"#) }
    actions.loadRetryState = { id, stage in decodeFixture(TaskRetryState.self, """
      {"taskId":"\(id)","stage":"\(stage)","admissionCount":0,"executedCount":0,"transientRetryCount":0,"interruptedCount":0,"authorizations":[],"telemetry":"unavailable"}
      """) }
    return actions
  }

  private static let events: [AgentEvent] = [
    AgentEvent(id: 1, timestamp: Date().addingTimeInterval(-120), type: .status, summary: "Checkpoint restored after reconnect."),
    AgentEvent(id: 2, timestamp: Date().addingTimeInterval(-100), type: .toolUse, summary: "Read reconnect implementation", detail: "src/pods/reconnect.ts", toolName: "read"),
    AgentEvent(id: 3, timestamp: Date().addingTimeInterval(-80), type: .fileChange, summary: "Updated retry regression coverage."),
    AgentEvent(id: 4, timestamp: Date().addingTimeInterval(-60), type: .progress, summary: "M4/4 · Add regression coverage"),
    AgentEvent(id: 5, timestamp: Date().addingTimeInterval(-30), type: .status, summary: "Validation completed; human review required.")
  ]

  private static let fixtureReadiness = ReadinessReview(status: .risky, summary: "Review checkpoint compatibility before approval.", computedAt: Date(), areas: ReadinessArea.allCases.map { area in
    ReadinessAreaReview(area: area, status: area == .validation ? .risky : .ready, title: area.label, summary: area == .validation ? "Confirm compatibility with older saved checkpoints." : "Recorded sources support this area.", sourceRefs: [ReadinessSourceRef(kind: .validation, label: "Validation")])
  }, findings: [ReadinessFinding(id: "checkpoint-compatibility", area: .validation, severity: .warning, title: "Older checkpoint compatibility", detail: "Inspect the fallback path and recorded recovery checks before approving.", sourceRefs: [ReadinessSourceRef(kind: .diff, label: "Changed files")])])

  private static var fixtureFiles: [SessionFileEntry] { decodeFixture([SessionFileEntry].self, #"[{"path":"RECOVERY.md","size":130,"modified":1792274400000},{"path":"validation-report.txt","size":120,"modified":1792274400000}]"#) }
  private static var fixtureDiff: DiffApiResponse { decodeFixture(DiffApiResponse.self, #"{"files":[{"path":"src/pods/reconnect.ts","status":"modified","diff":"diff --git a/src/pods/reconnect.ts b/src/pods/reconnect.ts\n--- a/src/pods/reconnect.ts\n+++ b/src/pods/reconnect.ts\n@@ -1,2 +1,3 @@\n function reconnect() {\n+  restoreCheckpoint();\n }"}],"stats":{"added":1,"removed":0,"changed":1},"commits":[]}"#) }
  private static var validationHistory: [StoredValidationResponse] { decodeFixture([StoredValidationResponse].self, #"[{"id":"fixture-run-1","podId":"retry-demo","attempt":1,"sequence":1,"cycle":0,"createdAt":"2026-10-17T10:00:00Z","result":{"podId":"retry-demo","attempt":1,"timestamp":"2026-10-17T10:00:00Z","smoke":{"status":"fail","build":{"status":"fail","output":"Missing checkpoint version","duration":1200},"health":{"status":"skip","url":"http://localhost/health","responseCode":null,"duration":0,"responseBody":null},"pages":[]},"overall":"fail","duration":1200}}]"#) }
  private static func fixtureQuality(_ id: String) -> PodQualitySignals { decodeFixture(PodQualitySignals.self, """
    {"podId":"\(id)","inspectionAvailability":"available","readCount":12,"editCount":3,"modifiedFileCount":3,"readEditRatio":4,"editsWithoutPriorRead":0,"userInterrupts":0,"editChurnCount":0,"tellsCount":0,"prFixAttempts":0,"validationPassed":true,"tokens":{"input":12000,"output":3400,"costUsd":1.84},"grade":"green","score":84,"model":"Codex"}
    """) }

  static let pods: [Pod] = [
    Pod(id: "retry-demo", status: .validated, branch: "fix/reconnect-retry", profileName: "backend",
        task: "Preserve active work when a daemon connection drops, then resume safely after reconnecting.", model: "Codex", startedAt: Date().addingTimeInterval(-1080),
        diffStats: DiffStats(added: 86, removed: 24, files: 3),
        validationChecks: ValidationChecks(smoke: true, setup: true, build: true, tests: true, lint: true, sast: true, review: true,
            buildOutput: "Workspace packages built successfully.", testOutput: "3 recovery regression checks passed.",
            reviewReasoning: "Checkpoint restore happens before reconnect. Existing checkpoint versions remain supported."), hasWebUi: true,
        phase: PhaseProgress(current: 4, total: 4, description: "Add regression coverage"), costUsd: 1.84, commitCount: 2, taskSummary: TaskSummary(actualSummary: "Restored the saved checkpoint before reconnecting and added regression coverage for repeatable recovery.", deviations: [DeviationItem(step: "Checkpoint format", planned: "Introduce a new handoff schema", actual: "Extend the existing checkpoint contract", reason: "Keep active pods compatible.")]),
        profileSnapshot: MockProfiles.backend, briefTitle: "Fix retry behaviour on reconnect", seriesId: "resilience", seriesName: "Daemon resilience",
        seriesDescription: "Restore saved work, reconnect safely, and verify recovery without repeating completed side effects.",
        seriesDesign: "# Recovery design\n\nRestore the checkpoint before starting the collector. Verify recovery in dependent test pods, then publish the runbook.",
        dependsOnPodIds: ["checkpoint-demo"],
        requireSidecars: ["postgres"], sidecarContainerIds: ["postgres": "fixture-db"], testRunBranches: ["test/reconnect"], readinessReview: Self.fixtureReadiness),
    Pod(id: "mapping-demo", status: .complete, branch: "audit/failure-paths", profileName: "backend", task: "Map interrupted handoff and recovery failure paths.", model: "Codex", startedAt: Date().addingTimeInterval(-3600), costUsd: 0.42, profileSnapshot: MockProfiles.backend, briefTitle: "Map failure paths", seriesId: "resilience", seriesName: "Daemon resilience"),
    Pod(id: "checkpoint-demo", status: .complete, branch: "fix/saved-work", profileName: "backend", task: "Preserve the saved checkpoint across connection loss.", model: "Codex", startedAt: Date().addingTimeInterval(-2400), costUsd: 1.26, profileSnapshot: MockProfiles.backend, briefTitle: "Preserve saved work", seriesId: "resilience", seriesName: "Daemon resilience", dependsOnPodIds: ["mapping-demo"]),
    Pod(id: "recovery-tests-demo", status: .queued, branch: "test/recovery-paths", profileName: "backend", task: "Exercise interrupted recovery paths.", model: "Codex", startedAt: Date().addingTimeInterval(-900), profileSnapshot: MockProfiles.backend, briefTitle: "Exercise recovery paths", seriesId: "resilience", seriesName: "Daemon resilience", dependsOnPodIds: ["retry-demo"]),
    Pod(id: "guide-demo", status: .queued, branch: "docs/recovery-guide", profileName: "webapp", task: "Update the operator recovery guide.", model: "Claude", startedAt: Date().addingTimeInterval(-800), profileSnapshot: MockProfiles.webapp, briefTitle: "Update recovery guide", seriesId: "resilience", seriesName: "Daemon resilience", dependsOnPodIds: ["recovery-tests-demo"]),
    Pod(id: "terminal-demo", status: .running, pod: PodConfig(agentMode: .interactive), branch: "inspect/recovery", profileName: "backend", task: "Inspect recovery in an interactive workspace.", model: "Codex", startedAt: Date().addingTimeInterval(-120), profileSnapshot: MockProfiles.backend, briefTitle: "Interactive recovery workspace"),
    Pod(id: "cleanup-demo", status: .failed, branch: "fix/container-cleanup", profileName: "backend", task: "Preserve active allocations while removing orphaned containers.", model: "Claude", startedAt: Date().addingTimeInterval(-1560),
        validationChecks: ValidationChecks(smoke: false, build: false, buildOutput: "Container validation could not start: Docker socket unavailable."),
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
