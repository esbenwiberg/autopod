import SwiftUI

/// Root view — three-column layout: Sidebar | Fleet/List | Detail
public struct MainView: View {
    public var sessions: [Session]
    public var isConnected: Bool
    public var connectionLabel: String
    public var connectionState: String
    public var isLoading: Bool
    public var actions: SessionActions
    public var profileNames: [String]
    public var sessionEvents: [String: [AgentEvent]]
    public var sessionDiffs: [String: String]
    public var terminalOutput: String
    public var terminalState: String
    public var onTerminalInput: ((String) -> Void)?
    public var onTerminalConnect: ((String) -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var onRefresh: (() async -> Void)?
    public var onSelectSession: ((String?) -> Void)?

    @Binding public var selectedSessionId: String?

    public init(
        sessions: [Session] = MockData.all,
        selectedSessionId: Binding<String?> = .constant(nil),
        isConnected: Bool = true,
        connectionLabel: String = "localhost:3000",
        connectionState: String = "Connected",
        isLoading: Bool = false,
        actions: SessionActions = .preview,
        profileNames: [String] = ["my-app", "webapp", "backend"],
        sessionEvents: [String: [AgentEvent]] = [:],
        sessionDiffs: [String: String] = [:],
        terminalOutput: String = "",
        terminalState: String = "disconnected",
        onTerminalInput: ((String) -> Void)? = nil,
        onTerminalConnect: ((String) -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        onRefresh: (() async -> Void)? = nil,
        onSelectSession: ((String?) -> Void)? = nil
    ) {
        self.sessions = sessions
        self._selectedSessionId = selectedSessionId
        self.isConnected = isConnected
        self.connectionLabel = connectionLabel
        self.connectionState = connectionState
        self.isLoading = isLoading
        self.actions = actions
        self.profileNames = profileNames
        self.sessionEvents = sessionEvents
        self.sessionDiffs = sessionDiffs
        self.terminalOutput = terminalOutput
        self.terminalState = terminalState
        self.onTerminalInput = onTerminalInput
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.onRefresh = onRefresh
        self.onSelectSession = onSelectSession
    }

    @State private var sidebarSelection: SidebarItem = .attention
    @State private var showCreateSheet = false
    @State private var showCommandPalette = false
    @State private var viewMode: ViewMode = .cards

    private var selectedSession: Session? {
        sessions.first { $0.id == selectedSessionId }
    }

    private var filteredSessions: [Session] {
        switch sidebarSelection {
        case .attention:      sessions.filter { $0.status.needsAttention }
        case .running:        sessions.filter { $0.status.isActive && !$0.isWorkspace }
        case .workspaces:     sessions.filter { $0.isWorkspace }
        case .completed:      sessions.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }
        case .all:            sessions
        case .profile(let p): sessions.filter { $0.profileName == p }
        }
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(
                sessions: sessions,
                selection: $sidebarSelection,
                showCreateSheet: $showCreateSheet,
                isConnected: isConnected,
                connectionLabel: connectionLabel
            )
        } content: {
            VStack(spacing: 0) {
                contentToolbar
                Divider()
                contentArea
            }
            .frame(minWidth: 500)
        } detail: {
            if let session = selectedSession {
                DetailPanelView(
                    session: session,
                    events: eventsForSession(session),
                    actions: actions,
                    diffString: sessionDiffs[session.id],
                    terminalOutput: terminalOutput,
                    terminalState: terminalState,
                    onTerminalInput: onTerminalInput,
                    onTerminalConnect: { onTerminalConnect?(session.id) },
                    onTerminalDisconnect: onTerminalDisconnect
                )
            } else {
                emptyDetail
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showCreateSheet) {
            CreateSessionSheet(
                isPresented: $showCreateSheet,
                actions: actions,
                profileNames: profileNames
            )
        }
        .onChange(of: selectedSessionId) { _, newId in
            onSelectSession?(newId)
        }
        .overlay {
            if showCommandPalette {
                Color.black.opacity(0.2)
                    .ignoresSafeArea()
                    .onTapGesture { showCommandPalette = false }
                    .allowsHitTesting(true)
                VStack {
                    CommandPalette(
                        isPresented: $showCommandPalette,
                        sessions: sessions,
                        actions: actions,
                        onSelectSession: { id in
                            selectedSessionId = id
                        }
                    )
                    .padding(.top, 80)
                    Spacer()
                }
            }
        }
        .background {
            // Hidden button to catch Cmd+K
            Button("") { showCommandPalette.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .hidden()
        }
    }

    // MARK: - Content toolbar

    private var contentToolbar: some View {
        HStack {
            Text(sidebarSelection.label)
                .font(.headline)
            Text("\(filteredSessions.count)")
                .font(.system(.caption2).weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.blue.opacity(0.1))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
            Spacer()
            Picker("", selection: $viewMode) {
                Image(systemName: "rectangle.grid.2x2").tag(ViewMode.cards)
                Image(systemName: "list.bullet").tag(ViewMode.list)
            }
            .pickerStyle(.segmented)
            .frame(width: 80)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Content area (cards or list)

    @ViewBuilder
    private var contentArea: some View {
        if isLoading && sessions.isEmpty {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading sessions…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if sessions.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "tray")
                    .font(.system(size: 32))
                    .foregroundStyle(.tertiary)
                Text("No sessions")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Create a session to get started")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch viewMode {
            case .cards:
                cardGrid
            case .list:
                sessionList
            }
        }
    }

    private var cardGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 230), spacing: 10)],
                alignment: .leading,
                spacing: 10
            ) {
                ForEach(filteredSessions) { session in
                    SessionCardFinal(session: session, actions: actions)
                        .onTapGesture { selectedSessionId = session.id }
                }
            }
            .padding(16)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sessionList: some View {
        List(filteredSessions, selection: $selectedSessionId) { session in
            SessionListRow(session: session)
                .tag(session.id)
        }
        .listStyle(.inset)
    }

    // MARK: - Empty detail

    private var emptyDetail: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.on.rectangle.slash")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("Select a session")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Events for session

    private func eventsForSession(_ session: Session) -> [AgentEvent] {
        if let real = sessionEvents[session.id], !real.isEmpty {
            return real
        }
        // Fallback to mock data for previews
        switch session.status {
        case .running, .validated, .validating:  return MockEvents.running
        case .failed:                            return MockEvents.failed
        case .awaitingInput:                     return MockEvents.awaitingInput
        default:                                 return MockEvents.awaitingInput
        }
    }
}

// MARK: - View mode

enum ViewMode: String {
    case cards, list
}

// MARK: - Session list row (compact list view)

struct SessionListRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: session.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.branch)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                Text(session.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let diff = session.diffStats {
                HStack(spacing: 3) {
                    Text("+\(diff.added)")
                        .foregroundStyle(.green)
                    Text("-\(diff.removed)")
                        .foregroundStyle(.red)
                }
                .font(.system(.caption2, design: .monospaced))
            }
            Text(session.duration)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Previews

#Preview("Full app — cards") {
    MainView()
        .frame(width: 1200, height: 700)
}
