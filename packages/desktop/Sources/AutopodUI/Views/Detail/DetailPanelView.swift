import SwiftUI

/// Detail panel — shown when a session is selected. Tabbed: Overview, Logs, Diff, Validation.
public struct DetailPanelView: View {
    public let session: Session
    public let events: [AgentEvent]
    public var actions: SessionActions
    public var diffString: String?
    public var terminalOutput: String
    public var terminalState: String
    public var onTerminalInput: ((String) -> Void)?
    public var onTerminalConnect: (() -> Void)?
    public var onTerminalDisconnect: (() -> Void)?

    public init(
        session: Session, events: [AgentEvent], actions: SessionActions = .preview,
        diffString: String? = nil,
        terminalOutput: String = "", terminalState: String = "disconnected",
        onTerminalInput: ((String) -> Void)? = nil,
        onTerminalConnect: (() -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil
    ) {
        self.session = session; self.events = events; self.actions = actions
        self.diffString = diffString
        self.terminalOutput = terminalOutput; self.terminalState = terminalState
        self.onTerminalInput = onTerminalInput
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
    }

    @State private var selectedTab: DetailTab = .overview

    public var body: some View {
        VStack(spacing: 0) {
            // Session header
            detailHeader

            // Tab bar
            tabBar

            Divider()

            // Tab content
            Group {
                switch selectedTab {
                case .overview:  OverviewTab(session: session, events: events, actions: actions)
                case .logs:      LogStreamView(events: events, sessionBranch: session.branch)
                case .diff:      DiffTab(session: session, diffString: diffString)
                case .terminal:  TerminalTab(
                    session: session,
                    terminalOutput: terminalOutput,
                    terminalState: terminalState,
                    onInput: onTerminalInput,
                    onConnect: onTerminalConnect,
                    onDisconnect: onTerminalDisconnect
                )
                case .validation: ValidationTab(session: session)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var detailHeader: some View {
        HStack(spacing: 10) {
            StatusDot(status: session.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.id)
                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                HStack(spacing: 6) {
                    Text(session.profileName)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.model)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.duration)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            headerActions
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var headerActions: some View {
        HStack(spacing: 6) {
            switch session.status {
            case .running:
                Button {
                    Task { await actions.nudge(session.id) }
                } label: {
                    Label("Nudge", systemImage: "hand.tap")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
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
                Button {
                    Task { await actions.nudge(session.id) }
                } label: {
                    Label("Nudge", systemImage: "hand.tap")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

            case .validated:
                Button {
                    Task { await actions.approve(session.id) }
                } label: {
                    Label("Approve", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.green)
                Button("Reject") {
                    Task { await actions.reject(session.id, nil) }
                }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

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

            default:
                EmptyView()
            }
        }
    }

    // MARK: - Tab bar

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(DetailTab.allCases, id: \.self) { tab in
                Button {
                    withAnimation(.easeOut(duration: 0.12)) { selectedTab = tab }
                } label: {
                    VStack(spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 10))
                            Text(tab.label)
                                .font(.system(.caption).weight(selectedTab == tab ? .semibold : .regular))
                        }
                        .foregroundStyle(selectedTab == tab ? .primary : .secondary)
                        .padding(.horizontal, 12)
                        .padding(.top, 6)

                        Rectangle()
                            .fill(selectedTab == tab ? Color.accentColor : .clear)
                            .frame(height: 2)
                    }
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
    }

    // MARK: - Placeholder tabs


}

// MARK: - Tab enum

enum DetailTab: CaseIterable {
    case overview, logs, diff, terminal, validation

    var label: String {
        switch self {
        case .overview:    "Overview"
        case .logs:        "Logs"
        case .diff:        "Diff"
        case .terminal:    "Terminal"
        case .validation:  "Validation"
        }
    }

    var icon: String {
        switch self {
        case .overview:    "square.text.square"
        case .logs:        "text.line.last.and.arrowtriangle.forward"
        case .diff:        "doc.text.magnifyingglass"
        case .terminal:    "terminal"
        case .validation:  "checkmark.seal"
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
