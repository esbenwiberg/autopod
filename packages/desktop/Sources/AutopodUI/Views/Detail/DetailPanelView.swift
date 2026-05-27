import AppKit
import AutopodClient
import SwiftUI

/// Detail panel — shown when a pod is selected. Tabbed around operator questions:
/// Overview, Work, Validation, Evidence, Diff, Logs, Terminal, and Series.
public struct DetailPanelView: View {
    public let pod: Pod
    public let events: [AgentEvent]
    public var actions: PodActions
    /// All pods in the currently-selected pod's series, for the Series tab.
    /// Empty when the pod is standalone.
    public var seriesPods: [Pod]
    /// Callback invoked when a node is tapped in the Series tab's pipeline view.
    public var onSelectPod: ((String) -> Void)?
    /// Returns the cached event stream for any pod id — used by the Series tab's
    /// slide-in panel so it can show the activity feed for a sibling pod.
    public var eventsForPod: ((String) -> [AgentEvent])?
    /// Triggers a historical event fetch for a pod whose events haven't been
    /// loaded yet (e.g. when the user opens the panel for a sibling).
    public var loadEventsForPod: ((String) -> Void)?
    /// Returns the historical REST load state for a pod's cached events.
    public var relatedEventLoadStateForPod: ((String) -> RelatedEventLoadState)?
    public var diffResponse: DiffApiResponse?
    public var terminalState: String
    public var terminalDataPipe: TerminalDataPipe?
    public var onTerminalSendData: (([UInt8]) -> Void)?
    public var onTerminalResize: ((Int, Int) -> Void)?
    public var onTerminalConnect: (() -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var onRefreshDiff: (() -> Void)?
    public var loadFiles: ((String) async throws -> [SessionFileEntry])?
    public var loadArtifacts: ((String) async throws -> [SessionFileEntry])?
    public var loadContent: ((String, String) async throws -> SessionFileContent)?
    public var loadQuality: ((String) async throws -> PodQualitySignals)?
    public var loadPreviewStatus: ((String) async throws -> PreviewStatus)?
    public var loadValidationHistory: ((String) async throws -> [StoredValidationResponse])?
    public var isLoadingLogs: Bool
    public var logsLoadError: String?
    public var limitedLogCount: Int?
    public var onReloadLogs: (() -> Void)?
    public var onLoadAllLogs: (() -> Void)?
    /// Open the Create Series sheet pre-filled with this pod's branch + profile.
    /// Available on workspace pods (interactive) — both running (mid-flight handoff)
    /// and complete (post-hoc spawn). Nil-safe — menu items are gated on this being set.
    public var onLaunchSeriesFromPod: ((Pod) -> Void)?
    @Binding public var requestedTab: DetailTab?

    public init(
        pod: Pod, events: [AgentEvent], actions: PodActions = .preview,
        seriesPods: [Pod] = [],
        onSelectPod: ((String) -> Void)? = nil,
        eventsForPod: ((String) -> [AgentEvent])? = nil,
        loadEventsForPod: ((String) -> Void)? = nil,
        relatedEventLoadStateForPod: ((String) -> RelatedEventLoadState)? = nil,
        diffResponse: DiffApiResponse? = nil,
        terminalState: String = "disconnected",
        terminalDataPipe: TerminalDataPipe? = nil,
        onTerminalSendData: (([UInt8]) -> Void)? = nil,
        onTerminalResize: ((Int, Int) -> Void)? = nil,
        onTerminalConnect: (() -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        onRefreshDiff: (() -> Void)? = nil,
        loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
        loadArtifacts: ((String) async throws -> [SessionFileEntry])? = nil,
        loadContent: ((String, String) async throws -> SessionFileContent)? = nil,
        loadQuality: ((String) async throws -> PodQualitySignals)? = nil,
        loadPreviewStatus: ((String) async throws -> PreviewStatus)? = nil,
        loadValidationHistory: ((String) async throws -> [StoredValidationResponse])? = nil,
        isLoadingLogs: Bool = false,
        logsLoadError: String? = nil,
        limitedLogCount: Int? = nil,
        onReloadLogs: (() -> Void)? = nil,
        onLoadAllLogs: (() -> Void)? = nil,
        onLaunchSeriesFromPod: ((Pod) -> Void)? = nil,
        requestedTab: Binding<DetailTab?> = .constant(nil)
    ) {
        self.pod = pod; self.events = events; self.actions = actions
        self.seriesPods = seriesPods
        self.onSelectPod = onSelectPod
        self.eventsForPod = eventsForPod
        self.loadEventsForPod = loadEventsForPod
        self.relatedEventLoadStateForPod = relatedEventLoadStateForPod
        self.diffResponse = diffResponse
        self.terminalState = terminalState
        self.terminalDataPipe = terminalDataPipe
        self.onTerminalSendData = onTerminalSendData
        self.onTerminalResize = onTerminalResize
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.onRefreshDiff = onRefreshDiff
        self.loadFiles = loadFiles
        self.loadArtifacts = loadArtifacts
        self.loadContent = loadContent
        self.loadQuality = loadQuality
        self.loadPreviewStatus = loadPreviewStatus
        self.loadValidationHistory = loadValidationHistory
        self.isLoadingLogs = isLoadingLogs
        self.logsLoadError = logsLoadError
        self.limitedLogCount = limitedLogCount
        self.onReloadLogs = onReloadLogs
        self.onLoadAllLogs = onLoadAllLogs
        self.onLaunchSeriesFromPod = onLaunchSeriesFromPod
        self._requestedTab = requestedTab
    }

    @State private var selectedTab: DetailTab = .overview
    @State private var didCopyName: Bool = false
    @State private var showRelatedEventsDebug: Bool = false

    private var isTerminalAvailable: Bool { pod.pod.agentMode == .interactive }
    private var isEvidenceAvailable: Bool {
        pod.hasWorktree
        || pod.pod.output == .artifact
        || !(pod.validationChecks?.proofOfWorkScreenshots?.isEmpty ?? true)
        || !(pod.validationChecks?.taskReviewScreenshots?.isEmpty ?? true)
        || pod.artifactsPath != nil
    }
    private var relatedEventReferences: [RelatedEventReference] {
        Self.relatedEventReferences(for: pod, seriesPods: seriesPods)
    }
    @State private var showPromoteMenu: Bool = false

    /// Artifact payload beats everything; for series pods the graph is the landing view;
    /// otherwise Overview. Applied on first appear and when the selected pod changes.
    static func defaultTab(for pod: Pod) -> DetailTab {
        if pod.pod.output == .artifact { return .evidence }
        if pod.seriesId != nil { return .series }
        return .overview
    }

    nonisolated static func relatedEventReferences(
        for pod: Pod,
        seriesPods: [Pod]
    ) -> [RelatedEventReference] {
        var knownPods: [String: Pod] = [pod.id: pod]
        for seriesPod in seriesPods {
            knownPods[seriesPod.id] = seriesPod
        }

        var seen: Set<String> = [pod.id]
        var references: [RelatedEventReference] = []

        func append(id: String?, relationship: String) {
            guard let id, !id.isEmpty, seen.insert(id).inserted else { return }
            references.append(
                RelatedEventReference(id: id, relationship: relationship, pod: knownPods[id])
            )
        }

        if let linked = pod.linkedSessionId {
            let relationship = pod.isWorkspace
                ? "linked worker"
                : pod.hasPrFixContext ? "parent pod" : "linked workspace"
            append(id: linked, relationship: relationship)
        }

        append(id: pod.fixPodId, relationship: "current fix pod")

        for seriesPod in seriesPods where seriesPod.id != pod.id {
            append(id: seriesPod.id, relationship: seriesRelationship(from: pod, to: seriesPod))
        }

        return references
    }

    nonisolated private static func seriesRelationship(from pod: Pod, to related: Pod) -> String {
        if pod.dependsOnPodIds.contains(related.id) {
            return "series parent"
        }
        if related.dependsOnPodIds.contains(pod.id) {
            return "series child"
        }
        return "series sibling"
    }

    private func relatedEventLoadState(for id: String) -> RelatedEventLoadState {
        if id == pod.id {
            if isLoadingLogs { return .loading }
            if let logsLoadError { return .failed(logsLoadError) }
            return events.isEmpty ? .notLoaded : .loaded
        }

        if let state = relatedEventLoadStateForPod?(id) {
            if state == .notLoaded, let cachedEvents = eventsForPod?(id), !cachedEvents.isEmpty {
                return .loaded
            }
            return state
        }

        if let cachedEvents = eventsForPod?(id), !cachedEvents.isEmpty {
            return .loaded
        }
        return .notLoaded
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Pod header
            detailHeader

            // Tab bar
            tabBar

            Divider()

            // Tab content — terminal is kept alive across tab switches so the
            // SwiftTerm NSView (and its scrollback buffer) isn't destroyed.
            ZStack {
                switch selectedTab {
                case .overview:   OverviewTab(pod: pod, events: events, actions: actions, loadQuality: loadQuality, loadPreviewStatus: loadPreviewStatus)
                case .logs:       LogStreamView(
                    events: events,
                    sessionBranch: pod.branch,
                    isLoading: isLoadingLogs,
                    loadError: logsLoadError,
                    limitedEventCount: limitedLogCount,
                    onReload: onReloadLogs,
                    onLoadAll: onLoadAllLogs
                )
                case .diff:       DiffTab(pod: pod, diffResponse: diffResponse, onRefresh: onRefreshDiff)
                case .work:       WorkTab(pod: pod, loadQuality: loadQuality)
                case .validation: ValidationTab(
                    pod: pod,
                    actions: actions,
                    loadValidationHistory: loadValidationHistory
                )
                case .evidence:   EvidenceTab(
                    pod: pod,
                    loadFiles: loadFiles,
                    loadArtifacts: loadArtifacts,
                    loadContent: loadContent
                )
                case .terminal:   EmptyView()
                case .series:
                    SeriesPipelineView(
                        pods: seriesPods,
                        selectedPodId: pod.id,
                        onSelectPod: { onSelectPod?($0) },
                        panelEnabled: true,
                        actions: actions,
                        eventsForPod: { id in
                            // For the currently-focused pod, prefer the live events array
                            // (it's already being streamed). For siblings, fall back to the
                            // store lookup.
                            id == pod.id ? events : (eventsForPod?(id) ?? [])
                        },
                        loadEventsForPod: loadEventsForPod,
                        loadQuality: loadQuality,
                        requestTab: { tab in requestedTab = tab }
                    )
                }

                if isTerminalAvailable {
                    TerminalTab(
                        pod: pod,
                        terminalState: terminalState,
                        dataPipe: terminalDataPipe,
                        onSendData: onTerminalSendData,
                        onResize: onTerminalResize,
                        onConnect: onTerminalConnect,
                        onDisconnect: onTerminalDisconnect,
                        isSelected: selectedTab == .terminal
                    )
                    .opacity(selectedTab == .terminal ? 1 : 0)
                    .allowsHitTesting(selectedTab == .terminal)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // Hard floor on the panel's intrinsic height so transient content
        // (banners, expanded headers) can't propagate a larger min upwards
        // through NavigationSplitView and grow the whole window.
        .frame(maxWidth: .infinity, minHeight: 320, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { selectedTab = Self.defaultTab(for: pod) }
        .onChange(of: pod.id) { _, _ in selectedTab = Self.defaultTab(for: pod) }
        .onChange(of: requestedTab) { _, tab in
            guard let tab else { return }
            guard tab != .terminal || isTerminalAvailable else { requestedTab = nil; return }
            selectedTab = tab
            requestedTab = nil
        }
        .sheet(isPresented: $showRejectFeedback) { rejectFeedbackSheet }
        .sheet(isPresented: $showNudgeInput) { nudgeSheet }
        .sheet(isPresented: $showHandoffSheet) { handoffSheet }
        .sheet(isPresented: $showSingleSpecHandoffSheet) { singleSpecHandoffSheet }
        .sheet(isPresented: $showRelatedEventsDebug) {
            RelatedEventsDebugSheet(
                currentPodId: pod.id,
                references: relatedEventReferences,
                eventsForPod: { id in
                    id == pod.id ? events : (eventsForPod?(id) ?? [])
                },
                loadStateForPod: relatedEventLoadState(for:),
                loadEventsForPod: loadEventsForPod,
                onOpenPod: onSelectPod,
                onOpenLogs: onSelectPod == nil ? nil : { id in
                    onSelectPod?(id)
                    DispatchQueue.main.async { requestedTab = .logs }
                }
            )
        }
        .alert("Resume pod", isPresented: $showResumeInput) {
            TextField("Message for the agent…", text: $resumeInputText)
            Button("Resume") {
                let message = resumeInputText.isEmpty ? "Continue where you left off." : resumeInputText
                resumeInputText = ""
                Task { await actions.reply(pod.id, message) }
            }
            Button("Cancel", role: .cancel) {
                resumeInputText = ""
            }
        } message: {
            Text("Send a message to resume the agent. Leave blank for a default resume.")
        }
        .alert(
            recoverWorktreeSuccess ? "Worktree recovered" : "Recovery failed",
            isPresented: Binding(
                get: { recoverWorktreeResult != nil },
                set: { if !$0 { recoverWorktreeResult = nil } }
            )
        ) {
            Button("OK", role: .cancel) { recoverWorktreeResult = nil }
        } message: {
            Text(recoverWorktreeResult ?? "")
        }
    }

    // MARK: - Header

    private var detailHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Pick whichever fits horizontally — wide single row, else wrap
            // the action buttons onto a second (scrollable) row so they can't
            // squeeze the identity column to zero or push the header off
            // screen when there are many actions (failed pods can show 6+).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    podIdentity
                    Spacer(minLength: 8)
                    headerActions
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        podIdentity
                        Spacer(minLength: 0)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        headerActions
                    }
                }
            }

        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var podIdentity: some View {
        HStack(spacing: 10) {
            StatusDot(status: pod.status)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(pod.id)
                        .font(.system(.title3, design: .monospaced).weight(.semibold))
                        .foregroundStyle(pod.status == .complete ? .green : pod.status == .killed ? .red.opacity(0.6) : .primary)
                        .lineLimit(1)
                    Image(systemName: didCopyName ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10))
                        .foregroundStyle(didCopyName ? Color.green : Color.secondary.opacity(0.6))
                        .transition(.opacity)
                }
                .contentShape(Rectangle())
                .onTapGesture { copyPodName() }
                .help(didCopyName ? "Copied!" : "Click to copy name")
                HStack(spacing: 6) {
                    Text(pod.profileName)
                        .lineLimit(1)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(pod.model)
                        .lineLimit(1)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(pod.duration)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if let fixLifecycle = pod.prFixLifecycleLabel {
                    Label(fixLifecycle, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.indigo)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(fixLifecycle)
                }

                if let tagline = taskTagline {
                    Text(tagline)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(tagline)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(1)
        }
    }

    private var taskTagline: String? {
        let generatedCandidates = [
            pod.briefTitle,
            pod.plan?.summary,
            pod.taskSummary?.actualSummary,
            pod.latestActivity,
        ]
        .compactMap { $0 }
        .map { cleanTaskLine($0) }
        .filter { !$0.isEmpty && !isBoilerplateTaskLine($0) }

        let taskCandidates = pod.task
            .split(whereSeparator: \.isNewline)
            .map { cleanTaskLine(String($0)) }
            .filter { !$0.isEmpty && !isBoilerplateTaskLine($0) }

        let chosen = generatedCandidates.first ?? taskCandidates.first
        guard let chosen else { return nil }
        return truncateTagline(chosen)
    }

    private func cleanTaskLine(_ line: String) -> String {
        line
            .replacingOccurrences(of: #"^\s*[#>*\-\u{2022}\u{25CF}\u{25CB}]+\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isBoilerplateTaskLine(_ line: String) -> Bool {
        let lower = line.lowercased()
        return lower == "task"
            || lower == "summary"
            || lower == "plan"
            || lower.hasPrefix("## ")
            || lower.hasPrefix("previous session died")
            || lower.hasPrefix("read ")
            || lower.hasPrefix("loaded ")
            || lower.hasPrefix("searched ")
            || lower.hasPrefix("explore(")
            || lower.hasPrefix("update(")
            || lower.hasPrefix("auto mode ")
            || lower.contains("ctrl+o to expand")
    }

    private func truncateTagline(_ line: String) -> String {
        let maxLength = 180
        guard line.count > maxLength else { return line }
        return String(line.prefix(maxLength - 3)).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private func formatRecoverWorktreeResult(_ result: RecoverWorktreeResponse) -> String {
        guard let blockers = result.blockers, !blockers.isEmpty else {
            return result.message
        }
        let preview = blockers.prefix(8).map { "  \($0.status) \($0.path)" }.joined(separator: "\n")
        let suffix = blockers.count > 8 ? "\n  ... \(blockers.count - 8) more" : ""
        return "\(result.message)\n\nBlocking paths:\n\(preview)\(suffix)"
    }


    @ViewBuilder
    private var headerActions: some View {
        HStack(spacing: 6) {
            // Recover Worktree — surfaced whenever the worktree is compromised,
            // regardless of pod status. Every other action path (Create PR,
            // Resume, Rework, Restart) is disabled while the flag is set, so
            // without this the operator has no in-app way out. The daemon
            // endpoint validates that worktreeCompromised is true, so showing
            // the button is safe even if the flag has been cleared elsewhere.
            if pod.worktreeCompromised && pod.hasWorktree {
                Button {
                    Task {
                        if let result = await actions.recoverWorktree(pod.id) {
                            recoverWorktreeResult = formatRecoverWorktreeResult(result)
                            recoverWorktreeSuccess = result.recovered
                        }
                    }
                } label: {
                    Label("Recover Worktree", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
                .help("Repopulate the host worktree from the live container or, if the container is gone, restore deleted files from the agent's last commit on the bare repo. Clears the compromised flag on success.")
            }
            switch pod.status {
            case .queued:
                // Kick — re-enqueues a stuck queued pod (e.g. orphaned by a missing
                // profile or a transient queue hiccup). Safe, no state change.
                Button {
                    Task { await actions.kick(pod.id, nil) }
                } label: {
                    Label("Kick", systemImage: "bolt")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.blue)
                .help("Re-enqueue this pod. Use if it's stuck queued while slots are free.")
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .provisioning:
                // Kick — kills container and force-fails. Use when provisioning is hung.
                Button {
                    kickReasonText = ""
                    showKickSheet = true
                } label: {
                    Label("Kick", systemImage: "bolt")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.orange)
                .help("Kill the container and mark this pod failed so the slot frees up.")
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .running:
                if pod.pod.agentMode == .interactive {
                    Menu {
                        Button("Complete (push branch)") {
                            Task { await actions.complete(pod.id) }
                        }
                        if pod.isPromotable {
                            Divider()
                            Button("Hand off → Open PR") {
                                handoffTarget = "pr"
                                showHandoffSheet = true
                            }
                            Button("Hand off → Branch only") {
                                handoffTarget = "branch"
                                showHandoffSheet = true
                            }
                            Button("Hand off → Artifact") {
                                handoffTarget = "artifact"
                                showHandoffSheet = true
                            }
                            Divider()
                            Button("Submit as-is → Open PR") {
                                Task { await actions.promote(pod.id, "pr", nil, true) }
                            }
                        }
                        Divider()
                        Button("Hand off → Single spec") {
                            openSingleSpecHandoffSheet()
                        }
                        // Spawn a series from this workspace's briefs. Doesn't change
                        // this pod — just opens the Create Series sheet pre-filled
                        // with the workspace's branch + profile so the new pods stack
                        // on top of the user's in-flight work. The sheet syncs the
                        // branch after it appears so the user gets immediate feedback.
                        if let onLaunchSeriesFromPod {
                            Button("Hand off → Series") {
                                onLaunchSeriesFromPod(pod)
                            }
                        }
                    } label: {
                        Label("Complete", systemImage: "checkmark.circle")
                    }
                    .menuStyle(.borderedButton)
                    .controlSize(.small)
                    .tint(.green)
                } else {
                    Button {
                        showNudgeInput = true
                    } label: {
                        Label("Nudge", systemImage: "hand.tap")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    Button {
                        Task { await actions.pause(pod.id) }
                    } label: {
                        Label("Pause", systemImage: "pause.circle")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.yellow)
                }
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
                Button {
                    kickReasonText = ""
                    showKickSheet = true
                } label: {
                    Label("Kick", systemImage: "bolt")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.orange)
                .help("Force-fail this pod (kills the container) so its slot frees up. Reach for this when the pod looks hung.")

            case .paused:
                Button {
                    showResumeInput = true
                } label: {
                    Label("Resume", systemImage: "play.circle")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.green)
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .awaitingInput:
                // Reply is handled in OverviewTab inline
                EmptyView()

            case .validated:
                if pod.validationChecks?.allPassed != false || pod.validationWaiver != nil {
                    // All checks passed, or a human explicitly waived the failures.
                    Button {
                        Task { await actions.approve(pod.id) }
                    } label: {
                        Label(pod.validationWaiver == nil ? "Approve" : "Approve Waived", systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(pod.validationWaiver == nil ? .green : .orange)
                    Button("Reject") {
                        showRejectFeedback = true
                    }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else {
                    // Validation failed — rework/fix actions are primary
                    Button {
                        Task { await actions.rework(pod.id) }
                    } label: {
                        Label("Rework", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                    Button {
                        Task { await actions.fixManually(pod.id) }
                    } label: {
                        Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    forkButton
                    Button {
                        Task { await actions.approve(pod.id) }
                    } label: {
                        Label("Approve Anyway", systemImage: "checkmark")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }

            case .reviewRequired:
                Button {
                    Task { await actions.extendAttempts(pod.id, 2) }
                } label: {
                    Label("Extend Attempts", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
                Button {
                    Task { await actions.fixManually(pod.id) }
                } label: {
                    Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                forkButton
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .mergePending:
                Button {
                    spawnFixMessage = ""
                    showSpawnFixSheet = true
                } label: {
                    Label("Spawn Fix", systemImage: "hammer.circle")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
                .help("Spawn a fix pod — optionally include reviewer comments")
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .failed:
                if pod.isWorkspace {
                    // Restart — workspace pods have no agent, so the "Resume" /
                    // "Rework" distinction doesn't apply. The same /validate
                    // endpoint re-provisions a fresh container against the
                    // existing worktree. No tokens spent.
                    Button {
                        Task { await actions.rework(pod.id) }
                    } label: {
                        Label("Restart", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.blue)
                    .disabled(pod.worktreeCompromised || !pod.hasWorktree)
                    .help(pod.worktreeCompromised
                        ? "Worktree is compromised — recover it before restarting."
                        : !pod.hasWorktree
                        ? "Pod has no worktree to restart from."
                        : "Spin up a fresh container against the same worktree. No agent runs, no tokens spent.")
                } else {
                    // Resume — token-free recovery. Promoted to primary because it's the
                    // cheapest path: pushes/opens the PR if validation passed, otherwise
                    // re-runs validation only. Disabled when the worktree is unrecoverable.
                    Button {
                        Task { await actions.resume(pod.id) }
                    } label: {
                        Label("Resume", systemImage: "arrow.uturn.forward")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.blue)
                    .disabled(pod.worktreeCompromised || !pod.hasWorktree)
                    .help(pod.worktreeCompromised
                        ? "Worktree is compromised — recover it before resuming."
                        : !pod.hasWorktree
                        ? "Pod has no worktree to resume from."
                        : "Retry the cheapest recovery path — push + open PR if validation passed, otherwise re-run validation. No agent rework, no token spend.")
                    Button {
                        Task { await actions.rework(pod.id) }
                    } label: {
                        Label("Rework", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.orange)
                    .help("Re-run the agent from scratch with feedback. Spends tokens.")
                }
                Button {
                    Task { await actions.fixManually(pod.id) }
                } label: {
                    Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                forkButton
                if pod.latestActivity?.contains("PR fix attempts") == true {
                    Button {
                        Task { await actions.extendPrAttempts(pod.id, 3) }
                    } label: {
                        Label("Extend PR Attempts", systemImage: "arrow.clockwise.circle")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.orange)
                }
                // Force Complete — admin override. Skips push/PR/merge entirely.
                // Last-resort escape when downstream is broken and re-running burns tokens.
                Button {
                    forceCompleteReasonText = ""
                    showForceCompleteSheet = true
                } label: {
                    Label("Force Complete", systemImage: "checkmark.shield")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
                .help("Admin override — mark this pod complete without pushing/PR/merge. Reason persisted for audit.")
                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

            case .killed:
                Button {
                    Task { await actions.rework(pod.id) }
                } label: {
                    Label(pod.isWorkspace ? "Restart" : "Rework",
                          systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(pod.isWorkspace ? .blue : .orange)
                .help(pod.isWorkspace
                    ? "Spin up a fresh container against the same worktree. No agent runs, no tokens spent."
                    : "Re-run the agent from scratch with feedback. Spends tokens.")
                forkButton
                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

            default:
                if pod.isTerminal {
                    if pod.status == .complete {
                        // Completed workspace pods can spawn a series from their
                        // (now-pushed) branch. Same flow as PodCardFinal's context
                        // menu, exposed here so users don't have to right-click the
                        // card to find it.
                        if pod.isWorkspace, let onLaunchSeriesFromPod {
                            Button {
                                onLaunchSeriesFromPod(pod)
                            } label: {
                                Label("Launch Series", systemImage: "rectangle.3.group.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .tint(.purple)
                            .help("Open the Create Series sheet pre-filled with this workspace's branch + profile.")
                        }
                        if let prUrl = pod.prUrl {
                            Button {
                                NSWorkspace.shared.open(prUrl)
                            } label: {
                                Label("View PR", systemImage: "arrow.up.right.square")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            Button {
                                spawnFixMessage = ""
                                showSpawnFixSheet = true
                            } label: {
                                Label("Fix with Message", systemImage: "hammer.circle")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .tint(.orange)
                            .help("Spawn a fix pod with explicit reviewer instructions")
                        } else if pod.pod.output == .pr {
                            Button {
                                Task { await actions.retryCreatePr(pod.id) }
                            } label: {
                                Label("Create PR", systemImage: "arrow.up.doc")
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .tint(.blue)
                            .disabled(pod.worktreeCompromised)
                            .help(pod.worktreeCompromised
                                ? "Worktree sync failed — retrying would commit phantom deletions. Use the Recover Worktree button first."
                                : "PR creation failed — retry creating a pull request for this pod's branch")
                        }
                    }
                    forkButton
                    Button(role: .destructive) {
                        showDeleteConfirmation = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

            if !relatedEventReferences.isEmpty {
                Button {
                    showRelatedEventsDebug = true
                } label: {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Inspect related pod events")
            }
        }
        .confirmationDialog("Delete pod \(pod.id)?", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                Task { await actions.delete(pod.id) }
            }
        } message: {
            Text("This will permanently remove the pod record.")
        }
        .sheet(isPresented: $showSpawnFixSheet) {
            SpawnFixSheet(
                podId: pod.id,
                message: $spawnFixMessage,
                isPresented: $showSpawnFixSheet,
                onSpawn: { message in
                    await actions.spawnFix(pod.id, message.isEmpty ? nil : message)
                }
            )
        }
        .sheet(isPresented: $showForceCompleteSheet) {
            forceCompleteSheet
        }
        .sheet(isPresented: $showKickSheet) {
            kickSheet
        }
    }

    @State private var showNudgeInput = false
    @State private var nudgeInputText = ""
    @State private var showResumeInput = false
    @State private var resumeInputText = ""
    @State private var showRejectFeedback = false
    @State private var rejectFeedbackText = ""
    @State private var showDeleteConfirmation = false
    @State private var showSpawnFixSheet = false
    @State private var spawnFixMessage = ""
    @State private var showHandoffSheet = false
    @State private var handoffTarget: String? = nil
    @State private var handoffInstructionsText = ""
    @State private var handoffSkipAgent = false
    @State private var showSingleSpecHandoffSheet = false
    @State private var singleSpecPath = ""
    @State private var singleSpecPreview: ParsedBriefResponse?
    @State private var singleSpecErrorMessage: String?
    @State private var singleSpecSyncWarning: String?
    @State private var isSingleSpecPreviewing = false
    @State private var isSingleSpecSyncing = false
    @State private var isSingleSpecSubmitting = false
    @State private var singleSpecSyncGeneration = 0
    @State private var showForceCompleteSheet = false
    @State private var forceCompleteReasonText = ""
    @State private var showKickSheet = false
    @State private var kickReasonText = ""
    @State private var recoverWorktreeResult: String? = nil
    @State private var recoverWorktreeSuccess: Bool = false

    private func copyPodName() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pod.id, forType: .string)
        withAnimation(.easeOut(duration: 0.15)) { didCopyName = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run {
                withAnimation(.easeIn(duration: 0.2)) { didCopyName = false }
            }
        }
    }

    private var nudgeSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Nudge agent")
                .font(.headline)
            Text("Send a message to redirect the agent. Leave blank for a default nudge.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextEditor(text: $nudgeInputText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    nudgeInputText = ""
                    showNudgeInput = false
                }
                Spacer()
                Button("Send") {
                    let message = nudgeInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Please refocus on the task."
                        : nudgeInputText
                    nudgeInputText = ""
                    showNudgeInput = false
                    Task { await actions.nudge(pod.id, message) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
    }

    private var forceCompleteSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Force complete pod", systemImage: "checkmark.shield")
                .font(.headline)
            Text("Mark **\(pod.id)** as complete without pushing, opening a PR, or merging. The agent's work stays in the worktree as-is. Use this when the work is fine but a downstream step is stuck and re-running would burn tokens.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Reason (optional, persisted for audit)")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $forceCompleteReasonText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    forceCompleteReasonText = ""
                    showForceCompleteSheet = false
                }
                .keyboardShortcut(.escape)
                Spacer()
                Button("Force Complete") {
                    let reason = forceCompleteReasonText
                    forceCompleteReasonText = ""
                    showForceCompleteSheet = false
                    Task { await actions.forceComplete(pod.id, reason) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 420, idealWidth: 480)
    }

    private var kickSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Kick pod", systemImage: "bolt.horizontal")
                .font(.headline)
            Text("Force **\(pod.id)** to fail and free its concurrency slot. The container is killed; you can `Resume` or `Force Complete` afterward.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Reason (optional, persisted for audit)")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $kickReasonText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    kickReasonText = ""
                    showKickSheet = false
                }
                .keyboardShortcut(.escape)
                Spacer()
                Button("Kick") {
                    let reason = kickReasonText.trimmingCharacters(in: .whitespacesAndNewlines)
                    kickReasonText = ""
                    showKickSheet = false
                    Task { await actions.kick(pod.id, reason.isEmpty ? nil : reason) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 420, idealWidth: 480)
    }

    private var handoffTargetLabel: String {
        switch handoffTarget {
        case "pr": return "Open PR"
        case "branch": return "Branch only"
        case "artifact": return "Artifact"
        default: return "agent"
        }
    }

    private var handoffSummaryText: String {
        let commits = pod.commitCount
        let files = pod.diffStats?.files ?? 0
        let added = pod.diffStats?.added ?? 0
        let removed = pod.diffStats?.removed ?? 0
        if commits == 0 && files == 0 {
            return "No commits or diff yet — only your typed instructions will be included."
        }
        return "\(commits) commit\(commits == 1 ? "" : "s"), \(files) file\(files == 1 ? "" : "s") changed (+\(added)/-\(removed)) will be included as session summary."
    }

    private var handoffSheet: some View {
        // Skip-agent only makes sense when there's a downstream output to validate
        // and ship: pr/artifact. With "branch only" the plain Complete button
        // already covers "just push the commits", so we hide the toggle there.
        let skipAgentEligible = handoffTarget == "pr" || handoffTarget == "artifact"
        return VStack(alignment: .leading, spacing: 16) {
            Text("Hand off → \(handoffTargetLabel)")
                .font(.headline)
            Text("Tell the agent what to finish and anything tricky about your in-flight changes. Your commits and a diff summary are forwarded automatically — leave blank if there's nothing to add.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(.secondary)
                Text(handoffSummaryText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if skipAgentEligible {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("Skip agent — submit human work as-is", isOn: $handoffSkipAgent)
                    Text("Pod goes straight to validation/PR with your commits — no agent run.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            TextEditor(text: $handoffInstructionsText)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    handoffInstructionsText = ""
                    handoffTarget = nil
                    handoffSkipAgent = false
                    showHandoffSheet = false
                }
                Spacer()
                Button("Hand off") {
                    let trimmed = handoffInstructionsText.trimmingCharacters(in: .whitespacesAndNewlines)
                    let target = handoffTarget
                    let skipAgent = skipAgentEligible && handoffSkipAgent
                    handoffInstructionsText = ""
                    handoffTarget = nil
                    handoffSkipAgent = false
                    showHandoffSheet = false
                    Task {
                        await actions.promote(pod.id, target, trimmed.isEmpty ? nil : trimmed, skipAgent)
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(handoffTarget == nil)
            }
        }
        .padding(20)
        .frame(minWidth: 480)
    }

    private var singleSpecWorkerProfile: String {
        actions.workerProfileForProfile(pod.profileName) ?? pod.profileName
    }

    private var canLaunchSingleSpec: Bool {
        !isSingleSpecSyncing && !isSingleSpecSubmitting && singleSpecPreview != nil
    }

    private var singleSpecHandoffSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Hand off → Single spec")
                .font(.headline)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.branch")
                        .foregroundStyle(.secondary)
                    Text("Base branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(pod.branch)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .foregroundStyle(.secondary)
                    Text("Worker profile")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(singleSpecWorkerProfile)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                }
            }

            if isSingleSpecSyncing {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Syncing workspace branch...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let warning = singleSpecSyncWarning {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Spec path on branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("specs/my-feature", text: $singleSpecPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                        .onChange(of: singleSpecPath) { _, _ in
                            singleSpecPreview = nil
                            singleSpecErrorMessage = nil
                        }
                    Button(isSingleSpecPreviewing ? "Parsing…" : "Preview") {
                        Task { await previewSingleSpecHandoff() }
                    }
                    .disabled(
                        isSingleSpecPreviewing
                        || isSingleSpecSyncing
                        || isSingleSpecSubmitting
                        || singleSpecPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }

            if let error = singleSpecErrorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let preview = singleSpecPreview {
                singleSpecPreviewSection(preview)
            }

            HStack {
                Button("Cancel") {
                    resetSingleSpecHandoff()
                    showSingleSpecHandoffSheet = false
                }
                .keyboardShortcut(.escape)
                Spacer()
                Button(isSingleSpecSubmitting ? "Launching…" : "Launch pod") {
                    Task { await submitSingleSpecHandoff() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!canLaunchSingleSpec)
            }
        }
        .padding(20)
        .frame(minWidth: 520)
    }

    private func singleSpecPreviewSection(_ brief: ParsedBriefResponse) -> some View {
        let scenarioCount = brief.contract?.scenarios.count ?? 0
        let factCount = brief.contract?.requiredFacts.count ?? 0
        let reviewCount = brief.contract?.humanReview.count ?? 0
        let sidecarCount = brief.requireSidecars?.count ?? 0

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(brief.title)
                    .font(.system(.callout).weight(.semibold))
                    .lineLimit(2)
                Spacer()
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            HStack(spacing: 8) {
                singleSpecPreviewChip("\(scenarioCount) scenarios", color: .blue)
                singleSpecPreviewChip("\(factCount) facts", color: .green)
                singleSpecPreviewChip("\(reviewCount) review", color: .purple)
                if sidecarCount > 0 {
                    singleSpecPreviewChip("\(sidecarCount) sidecars", color: .orange)
                }
            }
            Text(brief.task)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func singleSpecPreviewChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func resetSingleSpecHandoff() {
        singleSpecSyncGeneration += 1
        singleSpecPath = ""
        singleSpecPreview = nil
        singleSpecErrorMessage = nil
        singleSpecSyncWarning = nil
        isSingleSpecPreviewing = false
        isSingleSpecSyncing = false
        isSingleSpecSubmitting = false
    }

    private func openSingleSpecHandoffSheet() {
        resetSingleSpecHandoff()
        showSingleSpecHandoffSheet = true
        let generation = singleSpecSyncGeneration + 1
        singleSpecSyncGeneration = generation
        Task {
            await syncSingleSpecHandoffBranch(generation: generation)
        }
    }

    private func syncSingleSpecHandoffBranch(generation: Int) async {
        guard singleSpecSyncGeneration == generation else { return }
        singleSpecSyncWarning = nil
        isSingleSpecSyncing = true
        let response = await actions.syncWorkspaceBranch(pod.id)
        guard singleSpecSyncGeneration == generation else { return }
        isSingleSpecSyncing = false
        if response == nil {
            singleSpecSyncWarning = "Could not sync the workspace branch. You can still preview, but branch-path specs may be stale."
        }
    }

    private func previewSingleSpecHandoff() async {
        let path = singleSpecPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, !isSingleSpecSyncing else { return }
        singleSpecErrorMessage = nil
        singleSpecPreview = nil
        isSingleSpecPreviewing = true
        defer { isSingleSpecPreviewing = false }

        guard let preview = await actions.previewBriefOnBranch(pod.profileName, pod.branch, path) else {
            singleSpecErrorMessage = actions.lastPreviewError() ?? "Could not parse that spec."
            return
        }
        singleSpecPreview = preview
    }

    private func submitSingleSpecHandoff() async {
        guard let brief = singleSpecPreview else { return }
        isSingleSpecSubmitting = true
        singleSpecErrorMessage = nil
        defer { isSingleSpecSubmitting = false }

        let metadata = BriefPodMetadata(
            contract: brief.contract,
            briefTitle: brief.title,
            touches: brief.touches,
            doesNotTouch: brief.doesNotTouch,
            startBranch: pod.branch
        )
        let id = await actions.createPod(
            singleSpecWorkerProfile,
            brief.task,
            nil,
            PodConfigRequest(agentMode: "auto", output: "pr", validate: true, promotable: false),
            pod.baseBranch,
            nil,
            nil,
            brief.requireSidecars,
            nil,
            metadata
        )

        if let id {
            resetSingleSpecHandoff()
            showSingleSpecHandoffSheet = false
            onSelectPod?(id)
        } else {
            singleSpecErrorMessage = actions.lastCreatePodError() ?? "Pod creation failed."
        }
    }

    private var rejectFeedbackSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Reject pod")
                .font(.headline)
            Text("Tell the agent what to fix. Leave blank for a generic rejection.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextEditor(text: $rejectFeedbackText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    rejectFeedbackText = ""
                    showRejectFeedback = false
                }
                Spacer()
                Button("Reject") {
                    let feedback = rejectFeedbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? nil
                        : rejectFeedbackText
                    rejectFeedbackText = ""
                    showRejectFeedback = false
                    Task { await actions.reject(pod.id, feedback) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
    }

    private var forkButton: some View {
        Button {
            Task { await actions.fork(pod.id) }
        } label: {
            Label("Fork", systemImage: "arrow.triangle.branch")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Create a new pod with the same config, starting from this pod's branch")
    }

    // MARK: - Tab bar

    private var visibleTabs: [DetailTab] {
        DetailTab.allCases.filter { tab in
            switch tab {
            case .series: return pod.seriesId != nil
            case .evidence: return isEvidenceAvailable
            default: return true
            }
        }
    }

    private var tabBar: some View {
        ViewThatFits(in: .horizontal) {
            tabBarRow(showLabels: true)
                .fixedSize(horizontal: true, vertical: false)
            tabBarRow(showLabels: false)
                .fixedSize(horizontal: true, vertical: false)
            tabBarFlow
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func tabBarRow(showLabels: Bool) -> some View {
        HStack(spacing: 4) {
            ForEach(visibleTabs, id: \.self) { tab in
                tabButton(tab, showLabel: showLabels)
            }
        }
    }

    private var tabBarFlow: some View {
        DetailTabFlowLayout(spacing: 4) {
            ForEach(visibleTabs, id: \.self) { tab in
                tabButton(tab, showLabel: true)
            }
        }
    }

    private func tabButton(_ tab: DetailTab, showLabel: Bool) -> some View {
        let isSelected = selectedTab == tab
        let isDisabled = tab == .terminal && !isTerminalAvailable
        let disabledHelp: String = {
            if tab == .terminal && !isTerminalAvailable { return "Terminal is only available for workspace pods" }
            return ""
        }()

        return Button {
            selectedTab = tab
        } label: {
            HStack(spacing: 5) {
                Image(systemName: tab.icon)
                    .font(.system(size: 11))
                    .frame(width: 14)
                if showLabel {
                    Text(tab.label)
                        .font(.system(.subheadline).weight(isSelected ? .semibold : .regular))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .foregroundStyle(isSelected ? .primary : isDisabled ? .tertiary : .secondary)
            .padding(.horizontal, showLabel ? 12 : 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? Color.white.opacity(0.08) : .clear)
            )
            .fixedSize(horizontal: true, vertical: false)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(isDisabled ? disabledHelp : tab.label)
    }

    // MARK: - Placeholder tabs


}

private struct DetailTabFlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}

// MARK: - Worktree-compromised banner

/// Warning banner shown when a pod's worktree has fallen out of sync with its
/// container after the auto-commit deletion guard tripped. Lives inside the
/// Overview tab's ScrollView so its multi-line text can't propagate a vertical
/// minimum upwards through NavigationSplitView and grow the window.
struct WorktreeCompromisedBanner: View {
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Worktree out of sync with container")
                    .font(.caption.weight(.semibold))
                Text("The auto-commit deletion guard blocked a phantom mass-delete. The agent's real work may still live in the container — don't retry the PR; use the Recover Worktree button in the header first.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Color.orange.opacity(0.35), lineWidth: 1)
        )
    }
}

// MARK: - Tab enum

public enum DetailTab: CaseIterable {
    case overview, work, validation, evidence, diff, logs, terminal, series

    var label: String {
        switch self {
        case .overview:    "Overview"
        case .work:        "Work"
        case .validation:  "Validation"
        case .evidence:    "Evidence"
        case .diff:        "Diff"
        case .logs:        "Logs"
        case .terminal:    "Terminal"
        case .series:      "Series"
        }
    }

    var icon: String {
        switch self {
        case .overview:    "square.text.square"
        case .work:        "doc.text.below.ecg"
        case .validation:  "checkmark.seal"
        case .evidence:    "photo.on.rectangle.angled"
        case .diff:        "doc.text.magnifyingglass"
        case .logs:        "text.line.last.and.arrowtriangle.forward"
        case .terminal:    "terminal"
        case .series:      "rectangle.3.group.fill"
        }
    }
}

// MARK: - Previews

#Preview("Detail — running") {
    DetailPanelView(pod: MockData.running, events: MockEvents.running)
        .frame(width: 600, height: 500)
}

#Preview("Detail — awaiting input") {
    DetailPanelView(pod: MockData.awaitingInput, events: MockEvents.awaitingInput)
        .frame(width: 600, height: 500)
}

#Preview("Detail — failed") {
    DetailPanelView(pod: MockData.failed, events: MockEvents.failed)
        .frame(width: 600, height: 500)
}
