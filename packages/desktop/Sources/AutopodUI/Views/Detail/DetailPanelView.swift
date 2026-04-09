import SwiftUI

/// Detail panel — shown when a session is selected. Tabbed: Overview, Logs, Diff, Validation.
public struct DetailPanelView: View {
    public let session: Session
    public let events: [AgentEvent]
    public var actions: SessionActions
    public var diffString: String?
    public var terminalState: String
    public var terminalDataPipe: TerminalDataPipe?
    public var onTerminalSendData: (([UInt8]) -> Void)?
    public var onTerminalResize: ((Int, Int) -> Void)?
    public var onTerminalConnect: (() -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var onRefreshDiff: (() -> Void)?
    @Binding public var requestedTab: DetailTab?

    public init(
        session: Session, events: [AgentEvent], actions: SessionActions = .preview,
        diffString: String? = nil,
        terminalState: String = "disconnected",
        terminalDataPipe: TerminalDataPipe? = nil,
        onTerminalSendData: (([UInt8]) -> Void)? = nil,
        onTerminalResize: ((Int, Int) -> Void)? = nil,
        onTerminalConnect: (() -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        onRefreshDiff: (() -> Void)? = nil,
        requestedTab: Binding<DetailTab?> = .constant(nil)
    ) {
        self.session = session; self.events = events; self.actions = actions
        self.diffString = diffString
        self.terminalState = terminalState
        self.terminalDataPipe = terminalDataPipe
        self.onTerminalSendData = onTerminalSendData
        self.onTerminalResize = onTerminalResize
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.onRefreshDiff = onRefreshDiff
        self._requestedTab = requestedTab
    }

    @State private var selectedTab: DetailTab = .overview
    @State private var isTaskExpanded: Bool = false

    private var isTerminalAvailable: Bool { session.isWorkspace }

    public var body: some View {
        VStack(spacing: 0) {
            // Session header
            detailHeader

            // Tab bar
            tabBar

            Divider()

            // Tab content — terminal is kept alive across tab switches so the
            // SwiftTerm NSView (and its scrollback buffer) isn't destroyed.
            ZStack {
                switch selectedTab {
                case .overview:   OverviewTab(session: session, events: events, actions: actions)
                case .logs:       LogStreamView(events: events, sessionBranch: session.branch)
                case .diff:       DiffTab(session: session, diffString: diffString, onRefresh: onRefreshDiff)
                case .validation: ValidationTab(session: session)
                case .summary:    SummaryTab(session: session)
                case .terminal:   EmptyView()
                }

                if isTerminalAvailable {
                    TerminalTab(
                        session: session,
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
        .onChange(of: requestedTab) { _, tab in
            guard let tab else { return }
            guard tab != .terminal || isTerminalAvailable else { requestedTab = nil; return }
            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) { selectedTab = tab }
            requestedTab = nil
        }
        .alert("Reject session", isPresented: $showRejectFeedback) {
            TextField("What needs to change?", text: $rejectFeedbackText)
            Button("Reject", role: .destructive) {
                let feedback = rejectFeedbackText.isEmpty ? nil : rejectFeedbackText
                rejectFeedbackText = ""
                Task { await actions.reject(session.id, feedback) }
            }
            Button("Cancel", role: .cancel) {
                rejectFeedbackText = ""
            }
        } message: {
            Text("Tell the agent what to fix. Leave blank for a generic rejection.")
        }
        .alert("Nudge agent", isPresented: $showNudgeInput) {
            TextField("Message for the agent…", text: $nudgeInputText)
            Button("Send") {
                let message = nudgeInputText.isEmpty ? "Please refocus on the task." : nudgeInputText
                nudgeInputText = ""
                Task { await actions.nudge(session.id, message) }
            }
            Button("Cancel", role: .cancel) {
                nudgeInputText = ""
            }
        } message: {
            Text("Send a message to redirect the agent. Leave blank for a default nudge.")
        }
        .alert("Resume session", isPresented: $showResumeInput) {
            TextField("Message for the agent…", text: $resumeInputText)
            Button("Resume") {
                let message = resumeInputText.isEmpty ? "Continue where you left off." : resumeInputText
                resumeInputText = ""
                Task { await actions.reply(session.id, message) }
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
                StatusDot(status: session.status)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.id)
                        .font(.system(.title3, design: .monospaced).weight(.semibold))
                        .foregroundStyle(session.status == .complete ? .green : session.status == .killed ? .red.opacity(0.6) : .primary)
                    HStack(spacing: 6) {
                        Text(session.profileName)
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(session.model)
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(session.duration)
                            .contentTransition(.numericText())
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                headerActions
            }

            if !session.task.isEmpty {
                Text(session.task)
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
            switch session.status {
            case .running:
                Button {
                    showNudgeInput = true
                } label: {
                    Label("Nudge", systemImage: "hand.tap")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button {
                    Task { await actions.pause(session.id) }
                } label: {
                    Label("Pause", systemImage: "pause.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.yellow)
                Button {
                    Task { await actions.kill(session.id) }
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
                    Task { await actions.kill(session.id) }
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
                if session.validationChecks?.allPassed != false {
                    // All checks passed (or no checks yet) — approve is primary
                    Button {
                        Task { await actions.approve(session.id) }
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
                        Task { await actions.rework(session.id) }
                    } label: {
                        Label("Rework", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                    Button {
                        Task { await actions.fixManually(session.id) }
                    } label: {
                        Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    forkButton
                    Button {
                        Task { await actions.approve(session.id) }
                    } label: {
                        Label("Approve Anyway", systemImage: "checkmark")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }

            case .reviewRequired:
                Button {
                    Task { await actions.extendAttempts(session.id, 2) }
                } label: {
                    Label("Extend Attempts", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
                Button {
                    Task { await actions.fixManually(session.id) }
                } label: {
                    Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                forkButton
                Button {
                    Task { await actions.kill(session.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)

            case .failed:
                Button {
                    Task { await actions.rework(session.id) }
                } label: {
                    Label("Rework", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.red)
                Button {
                    Task { await actions.fixManually(session.id) }
                } label: {
                    Label("Fix Manually", systemImage: "wrench.and.screwdriver")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                forkButton

            default:
                if session.isTerminal {
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
        .confirmationDialog("Delete session \(session.id)?", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                Task { await actions.delete(session.id) }
            }
        } message: {
            Text("This will permanently remove the session record.")
        }
    }

    @State private var showNudgeInput = false
    @State private var nudgeInputText = ""
    @State private var showResumeInput = false
    @State private var resumeInputText = ""
    @State private var showRejectFeedback = false
    @State private var rejectFeedbackText = ""
    @State private var showDeleteConfirmation = false

    private var forkButton: some View {
        Button {
            Task { await actions.fork(session.id) }
        } label: {
            Label("Fork", systemImage: "arrow.triangle.branch")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Create a new session with the same config, starting from this session's branch")
    }

    // MARK: - Tab bar

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(DetailTab.allCases, id: \.self) { tab in
                let isSelected = selectedTab == tab
                let isDisabled = tab == .terminal && !isTerminalAvailable
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
                .help(isDisabled ? "Terminal is only available for workspace sessions" : "")
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
    case overview, logs, diff, terminal, validation, summary

    var label: String {
        switch self {
        case .overview:    "Overview"
        case .logs:        "Logs"
        case .diff:        "Diff"
        case .terminal:    "Terminal"
        case .validation:  "Validation"
        case .summary:     "Summary"
        }
    }

    var icon: String {
        switch self {
        case .overview:    "square.text.square"
        case .logs:        "text.line.last.and.arrowtriangle.forward"
        case .diff:        "doc.text.magnifyingglass"
        case .terminal:    "terminal"
        case .validation:  "checkmark.seal"
        case .summary:     "doc.text.below.ecg"
        }
    }
}

// MARK: - Previews

#Preview("Detail — running") {
    DetailPanelView(session: MockData.running, events: MockEvents.running)
        .frame(width: 600, height: 500)
}

#Preview("Detail — awaiting input") {
    DetailPanelView(session: MockData.awaitingInput, events: MockEvents.awaitingInput)
        .frame(width: 600, height: 500)
}

#Preview("Detail — failed") {
    DetailPanelView(session: MockData.failed, events: MockEvents.failed)
        .frame(width: 600, height: 500)
}
