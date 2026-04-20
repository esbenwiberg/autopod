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
    public var isLoadingLogs: Bool
    public var logsLoadError: String?
    public var onReloadLogs: (() -> Void)?
    @Binding public var requestedTab: DetailTab?

    public init(
        pod: Pod, events: [AgentEvent], actions: PodActions = .preview,
        seriesPods: [Pod] = [],
        onSelectPod: ((String) -> Void)? = nil,
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
        isLoadingLogs: Bool = false,
        logsLoadError: String? = nil,
        onReloadLogs: (() -> Void)? = nil,
        requestedTab: Binding<DetailTab?> = .constant(nil)
    ) {
        self.pod = pod; self.events = events; self.actions = actions
        self.seriesPods = seriesPods
        self.onSelectPod = onSelectPod
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
                case .overview:   OverviewTab(pod: pod, events: events, actions: actions)
                case .logs:       LogStreamView(
                    events: events,
                    sessionBranch: pod.branch,
                    isLoading: isLoadingLogs,
                    loadError: logsLoadError,
                    onReload: onReloadLogs
                )
                case .diff:       DiffTab(pod: pod, diffString: diffString, onRefresh: onRefreshDiff)
                case .validation: ValidationTab(pod: pod, actions: actions)
                case .summary:    SummaryTab(pod: pod)
                case .terminal:   EmptyView()
                case .markdown:   MarkdownTab(pod: pod, loadFiles: loadFiles, loadContent: loadContent)
                case .series:
                    SeriesPipelineView(
                        pods: seriesPods,
                        selectedPodId: pod.id,
                        onSelectPod: { onSelectPod?($0) }
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
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { selectedTab = Self.defaultTab(for: pod) }
        .onChange(of: pod.id) { _, _ in selectedTab = Self.defaultTab(for: pod) }
        .onChange(of: requestedTab) { _, tab in
            guard let tab else { return }
            guard tab != .terminal || isTerminalAvailable else { requestedTab = nil; return }
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) { selectedTab = tab }
            requestedTab = nil
        }
        .sheet(isPresented: $showRejectFeedback) { rejectFeedbackSheet }
        .sheet(isPresented: $showNudgeInput) { nudgeSheet }
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
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(pod.model)
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(pod.duration)
                            .contentTransition(.numericText())
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                headerActions
            }

            if !pod.task.isEmpty {
                Text(pod.task)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(isTaskExpanded ? nil : 2)
                    .padding(.top, 8)
                    .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { isTaskExpanded.toggle() } }
                    .help("Click to \(isTaskExpanded ? "collapse" : "expand") task")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    @ViewBuilder
    private var headerActions: some View {
        HStack(spacing: 6) {
            switch pod.status {
            case .running:
                if pod.pod.agentMode == .interactive {
                    Menu {
                        Button("Complete (push branch)") {
                            Task { await actions.complete(pod.id) }
                        }
                        if pod.isPromotable {
                            Divider()
                            Button("Hand off → Open PR") {
                                Task { await actions.promote(pod.id, "pr") }
                            }
                            Button("Hand off → Branch only") {
                                Task { await actions.promote(pod.id, "branch") }
                            }
                            Button("Hand off → Artifact") {
                                Task { await actions.promote(pod.id, "artifact") }
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
                    Task { await actions.spawnFix(pod.id) }
                } label: {
                    Label("Spawn Fix", systemImage: "hammer.circle")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
                .help("Manually spawn a fix pod for the failing PR checks")
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .failed:
                Button {
                    Task { await actions.rework(pod.id) }
                } label: {
                    Label("Rework", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.red)
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
    }

    @State private var showNudgeInput = false
    @State private var nudgeInputText = ""
    @State private var showResumeInput = false
    @State private var resumeInputText = ""
    @State private var showRejectFeedback = false
    @State private var rejectFeedbackText = ""
    @State private var showDeleteConfirmation = false

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
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) { selectedTab = tab }
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
