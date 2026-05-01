import AppKit
import AutopodClient
import SwiftUI

/// Detail panel — shown when a pod is selected. Tabbed: Overview, Logs, Diff, Validation.
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
    public var diffString: String?
    public var terminalState: String
    public var terminalDataPipe: TerminalDataPipe?
    public var onTerminalSendData: (([UInt8]) -> Void)?
    public var onTerminalResize: ((Int, Int) -> Void)?
    public var onTerminalConnect: (() -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var onRefreshDiff: (() -> Void)?
    public var loadFiles: ((String) async throws -> [SessionFileEntry])?
    public var loadContent: ((String, String) async throws -> SessionFileContent)?
    public var loadQuality: ((String) async throws -> PodQualitySignals)?
    public var isLoadingLogs: Bool
    public var logsLoadError: String?
    public var onReloadLogs: (() -> Void)?
    @Binding public var requestedTab: DetailTab?

    public init(
        pod: Pod, events: [AgentEvent], actions: PodActions = .preview,
        seriesPods: [Pod] = [],
        onSelectPod: ((String) -> Void)? = nil,
        eventsForPod: ((String) -> [AgentEvent])? = nil,
        loadEventsForPod: ((String) -> Void)? = nil,
        diffString: String? = nil,
        terminalState: String = "disconnected",
        terminalDataPipe: TerminalDataPipe? = nil,
        onTerminalSendData: (([UInt8]) -> Void)? = nil,
        onTerminalResize: ((Int, Int) -> Void)? = nil,
        onTerminalConnect: (() -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        onRefreshDiff: (() -> Void)? = nil,
        loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
        loadContent: ((String, String) async throws -> SessionFileContent)? = nil,
        loadQuality: ((String) async throws -> PodQualitySignals)? = nil,
        isLoadingLogs: Bool = false,
        logsLoadError: String? = nil,
        onReloadLogs: (() -> Void)? = nil,
        requestedTab: Binding<DetailTab?> = .constant(nil)
    ) {
        self.pod = pod; self.events = events; self.actions = actions
        self.seriesPods = seriesPods
        self.onSelectPod = onSelectPod
        self.eventsForPod = eventsForPod
        self.loadEventsForPod = loadEventsForPod
        self.diffString = diffString
        self.terminalState = terminalState
        self.terminalDataPipe = terminalDataPipe
        self.onTerminalSendData = onTerminalSendData
        self.onTerminalResize = onTerminalResize
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.onRefreshDiff = onRefreshDiff
        self.loadFiles = loadFiles
        self.loadContent = loadContent
        self.loadQuality = loadQuality
        self.isLoadingLogs = isLoadingLogs
        self.logsLoadError = logsLoadError
        self.onReloadLogs = onReloadLogs
        self._requestedTab = requestedTab
    }

    @State private var selectedTab: DetailTab = .overview
    @State private var isTaskExpanded: Bool = false
    @State private var didCopyName: Bool = false

    private var isTerminalAvailable: Bool { pod.pod.agentMode == .interactive }
    private var isMarkdownAvailable: Bool { pod.hasWorktree || pod.pod.output == .artifact }
    @State private var showPromoteMenu: Bool = false

    /// Artifact payload beats everything; for series pods the graph is the landing view;
    /// otherwise Overview. Applied on first appear and when the selected pod changes.
    static func defaultTab(for pod: Pod) -> DetailTab {
        if pod.pod.output == .artifact { return .markdown }
        if pod.seriesId != nil { return .series }
        return .overview
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
                case .overview:   OverviewTab(pod: pod, events: events, actions: actions, loadQuality: loadQuality)
                case .logs:       LogStreamView(
                    events: events,
                    sessionBranch: pod.branch,
                    isLoading: isLoadingLogs,
                    loadError: logsLoadError,
                    onReload: onReloadLogs
                )
                case .diff:       DiffTab(pod: pod, diffString: diffString, onRefresh: onRefreshDiff)
                case .validation: ValidationTab(pod: pod, actions: actions)
                case .summary:    SummaryTab(pod: pod, loadQuality: loadQuality)
                case .terminal:   EmptyView()
                case .markdown:   MarkdownTab(pod: pod, loadFiles: loadFiles, loadContent: loadContent)
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
    }

    // MARK: - Header

    private var detailHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
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
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                headerActions
            }

            if !pod.task.isEmpty {
                Text(pod.task)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(isTaskExpanded ? 8 : 2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
                    .onTapGesture { isTaskExpanded.toggle() }
                    .help("Click to \(isTaskExpanded ? "collapse" : "expand") task")
            }

            if pod.worktreeCompromised {
                worktreeCompromisedBanner
                    .padding(.top, 10)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var worktreeCompromisedBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Worktree out of sync with container")
                    .font(.caption.weight(.semibold))
                Text("The auto-commit deletion guard blocked a phantom mass-delete. The agent's real work may still live in the container — don't retry the PR; recover manually first.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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

    @ViewBuilder
    private var headerActions: some View {
        HStack(spacing: 6) {
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
                if pod.validationChecks?.allPassed != false {
                    // All checks passed (or no checks yet) — approve is primary
                    Button {
                        Task { await actions.approve(pod.id) }
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.green)
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
                    Label("Rework", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
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
                                ? "Worktree sync failed — retrying would commit phantom deletions. Recover manually first."
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
                    Task { await actions.spawnFix(pod.id, message.isEmpty ? nil : message) }
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
    @State private var showForceCompleteSheet = false
    @State private var forceCompleteReasonText = ""
    @State private var showKickSheet = false
    @State private var kickReasonText = ""

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
            default: return true
            }
        }
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(visibleTabs, id: \.self) { tab in
                let isSelected = selectedTab == tab
                let isDisabled = (tab == .terminal && !isTerminalAvailable) || (tab == .markdown && !isMarkdownAvailable)
                let disabledHelp: String = {
                    if tab == .terminal && !isTerminalAvailable { return "Terminal is only available for workspace pods" }
                    if tab == .markdown && !isMarkdownAvailable { return "Markdown viewer becomes available once the pod has a workspace" }
                    return ""
                }()
                Button {
                    selectedTab = tab
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: tab.icon)
                            .font(.system(size: 11))
                        Text(tab.label)
                            .font(.system(.subheadline).weight(isSelected ? .semibold : .regular))
                    }
                    .foregroundStyle(isSelected ? .primary : isDisabled ? .tertiary : .secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(isSelected ? Color.white.opacity(0.08) : .clear)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
                .help(disabledHelp)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    // MARK: - Placeholder tabs


}

// MARK: - Tab enum

public enum DetailTab: CaseIterable {
    case overview, logs, diff, terminal, markdown, validation, summary, series

    var label: String {
        switch self {
        case .overview:    "Overview"
        case .logs:        "Logs"
        case .diff:        "Diff"
        case .terminal:    "Terminal"
        case .markdown:    "Markdown"
        case .validation:  "Validation"
        case .summary:     "Summary"
        case .series:      "Series"
        }
    }

    var icon: String {
        switch self {
        case .overview:    "square.text.square"
        case .logs:        "text.line.last.and.arrowtriangle.forward"
        case .diff:        "doc.text.magnifyingglass"
        case .terminal:    "terminal"
        case .markdown:    "doc.richtext"
        case .validation:  "checkmark.seal"
        case .summary:     "doc.text.below.ecg"
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
