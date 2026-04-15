import AutopodClient
import SwiftUI

/// Root view — three-column layout: Sidebar | Fleet/List | Detail
public struct MainView: View {
    public var sessions: [Session]
    public var scheduledJobs: [ScheduledJob]
    public var isConnected: Bool
    public var connectionLabel: String
    public var connectionState: String
    public var isLoading: Bool
    public var actions: SessionActions
    public var profileNames: [String]
    public var selectedSessionEvents: [AgentEvent]
    public var isLoadingLogs: Bool
    public var logsLoadError: String?
    public var onReloadLogs: (() -> Void)?
    public var sessionDiffs: [String: String]
    public var terminalState: String
    public var terminalDataPipe: TerminalDataPipe?
    public var onTerminalSendData: (([UInt8]) -> Void)?
    public var onTerminalResize: ((Int, Int) -> Void)?
    public var onTerminalConnect: ((String) -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var onRefresh: (() async -> Void)?
    public var onSelectSession: ((String?) -> Void)?
    public var onRefreshDiff: ((String) -> Void)?
    public var onShowSettings: (() -> Void)?
    public var loadFiles: ((String) async throws -> [SessionFileEntry])?
    public var loadContent: ((String, String) async throws -> SessionFileContent)?

    // Scheduled Jobs
    public var onRunCatchup: ((ScheduledJob) -> Void)?
    public var onSkipCatchup: ((ScheduledJob) -> Void)?
    public var onTriggerJob: ((ScheduledJob) -> Void)?

    // Memory
    public var memoryEntries: [MemoryEntry]
    public var pendingMemoryCount: Int
    public var onApproveMemory: (String) -> Void
    public var onRejectMemory: (String) -> Void
    public var onDeleteMemory: (String) -> Void
    public var onEditMemory: ((String, String) -> Void)?
    public var onCreateMemory: ((MemoryScope, String?, String, String) -> Void)?
    public var onLoadMemories: (() async -> Void)?

    @Binding public var selectedSessionId: String?

    public init(
        sessions: [Session] = MockData.all,
        scheduledJobs: [ScheduledJob] = [],
        selectedSessionId: Binding<String?> = .constant(nil),
        isConnected: Bool = true,
        connectionLabel: String = "localhost:3000",
        connectionState: String = "Connected",
        isLoading: Bool = false,
        actions: SessionActions = .preview,
        profileNames: [String] = ["my-app", "webapp", "backend"],
        selectedSessionEvents: [AgentEvent] = [],
        isLoadingLogs: Bool = false,
        logsLoadError: String? = nil,
        onReloadLogs: (() -> Void)? = nil,
        sessionDiffs: [String: String] = [:],
        terminalState: String = "disconnected",
        terminalDataPipe: TerminalDataPipe? = nil,
        onTerminalSendData: (([UInt8]) -> Void)? = nil,
        onTerminalResize: ((Int, Int) -> Void)? = nil,
        onTerminalConnect: ((String) -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        onRefresh: (() async -> Void)? = nil,
        onSelectSession: ((String?) -> Void)? = nil,
        onRefreshDiff: ((String) -> Void)? = nil,
        onShowSettings: (() -> Void)? = nil,
        loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
        loadContent: ((String, String) async throws -> SessionFileContent)? = nil,
        onRunCatchup: ((ScheduledJob) -> Void)? = nil,
        onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
        onTriggerJob: ((ScheduledJob) -> Void)? = nil,
        memoryEntries: [MemoryEntry] = [],
        pendingMemoryCount: Int = 0,
        onApproveMemory: @escaping (String) -> Void = { _ in },
        onRejectMemory: @escaping (String) -> Void = { _ in },
        onDeleteMemory: @escaping (String) -> Void = { _ in },
        onEditMemory: ((String, String) -> Void)? = nil,
        onCreateMemory: ((MemoryScope, String?, String, String) -> Void)? = nil,
        onLoadMemories: (() async -> Void)? = nil
    ) {
        self.sessions = sessions
        self.scheduledJobs = scheduledJobs
        self._selectedSessionId = selectedSessionId
        self.isConnected = isConnected
        self.connectionLabel = connectionLabel
        self.connectionState = connectionState
        self.isLoading = isLoading
        self.actions = actions
        self.profileNames = profileNames
        self.selectedSessionEvents = selectedSessionEvents
        self.isLoadingLogs = isLoadingLogs
        self.logsLoadError = logsLoadError
        self.onReloadLogs = onReloadLogs
        self.sessionDiffs = sessionDiffs
        self.terminalState = terminalState
        self.terminalDataPipe = terminalDataPipe
        self.onTerminalSendData = onTerminalSendData
        self.onTerminalResize = onTerminalResize
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.onRefresh = onRefresh
        self.onSelectSession = onSelectSession
        self.onRefreshDiff = onRefreshDiff
        self.onShowSettings = onShowSettings
        self.loadFiles = loadFiles
        self.loadContent = loadContent
        self.onRunCatchup = onRunCatchup
        self.onSkipCatchup = onSkipCatchup
        self.onTriggerJob = onTriggerJob
        self.memoryEntries = memoryEntries
        self.pendingMemoryCount = pendingMemoryCount
        self.onApproveMemory = onApproveMemory
        self.onRejectMemory = onRejectMemory
        self.onDeleteMemory = onDeleteMemory
        self.onEditMemory = onEditMemory
        self.onCreateMemory = onCreateMemory
        self.onLoadMemories = onLoadMemories
    }

    @State private var sidebarSelection: SidebarItem = .attention
    @State private var showCreateSheet = false
    @State private var showCommandPalette = false
    @State private var viewMode: ViewMode = .cards
    @State private var cardDensity: CardDensity = .detailed
    @State private var sortOrder: SortOrder = .created
    @State private var selectedFeature: FeatureCategory?
    @State private var requestedDetailTab: DetailTab?

    private var selectedSession: Session? {
        sessions.first { $0.id == selectedSessionId }
    }

    /// Actions with `attachTerminal` wired to navigate + connect.
    private var wiredActions: SessionActions {
        var a = actions
        a.attachTerminal = { [onTerminalConnect] sessionId in
            let wasAlreadySelected = selectedSessionId == sessionId
            selectedSessionId = sessionId
            if wasAlreadySelected {
                requestedDetailTab = .terminal
            } else {
                // DetailPanelView is freshly created — delay so onChange can observe the change.
                DispatchQueue.main.async { requestedDetailTab = .terminal }
            }
            onTerminalConnect?(sessionId)
        }
        return a
    }

    private var filteredSessions: [Session] {
        let filtered: [Session] = switch sidebarSelection {
        case .attention:      sessions.filter { $0.status.needsAttention }
        case .active:         sessions.filter { ($0.status.isActive || $0.status.needsAttention) && !$0.isWorkspace }
        case .running:        sessions.filter { $0.status.isActive && !$0.isWorkspace }
        case .workspaces:     sessions.filter { $0.isWorkspace }
        case .completed:      sessions.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }
        case .all:            sessions
        case .analytics:        []
        case .history:          []
        case .memory:           []
        case .scheduledJobs:    []
        case .featureOverview:  []
        case .salesPitch:       []
        case .profile(let p):   sessions.filter { $0.profileName == p }
        }
        return filtered.sorted { a, b in
            switch sortOrder {
            case .created:    a.startedAt > b.startedAt
            case .lastActive: a.updatedAt > b.updatedAt
            }
        }
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(
                sessions: sessions,
                selection: $sidebarSelection,
                showCreateSheet: $showCreateSheet,
                isConnected: isConnected,
                connectionLabel: connectionLabel,
                pendingMemoryCount: pendingMemoryCount,
                scheduledJobCount: scheduledJobs.count,
                catchupPendingCount: scheduledJobs.filter { $0.catchupPending }.count,
                onShowSettings: onShowSettings
            )
        } content: {
            if sidebarSelection == .analytics {
                AnalyticsView(sessions: sessions)
                    .frame(minWidth: 600)
            } else if sidebarSelection == .history {
                HistoryView(sessions: sessions, actions: wiredActions, profileNames: profileNames)
                    .frame(minWidth: 600)
            } else if sidebarSelection == .memory {
                MemoryManagementView(
                    entries: memoryEntries,
                    scopeFilter: nil,
                    onApprove: onApproveMemory,
                    onReject: onRejectMemory,
                    onDelete: onDeleteMemory,
                    onEdit: onEditMemory,
                    onCreateMemory: onCreateMemory,
                    scopeNameLookup: { scope, id in
                        switch scope {
                        case .session:
                            guard let s = sessions.first(where: { $0.id == id }) else { return id }
                            let firstLine = s.task
                                .split(whereSeparator: \.isNewline)
                                .first
                                .map(String.init)?
                                .trimmingCharacters(in: .whitespaces) ?? ""
                            return firstLine.isEmpty ? s.branch : firstLine
                        case .profile:
                            return id
                        case .global:
                            return nil
                        }
                    }
                )
                .frame(minWidth: 600)
                .task { await onLoadMemories?() }
            } else if sidebarSelection == .scheduledJobs {
                ScheduledJobsView(
                    jobs: scheduledJobs,
                    onRunCatchup: onRunCatchup,
                    onSkipCatchup: onSkipCatchup,
                    onTriggerJob: onTriggerJob
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .salesPitch {
                SalesPitchView()
                    .frame(minWidth: 600)
            } else if sidebarSelection == .featureOverview {
                FeatureOverviewView(selectedFeature: $selectedFeature)
                    .frame(minWidth: 600)
            } else {
                VStack(spacing: 0) {
                    contentToolbar
                    Divider()
                    contentArea
                }
                .frame(minWidth: 500)
            }
        } detail: {
            if sidebarSelection == .salesPitch {
                VStack(spacing: 10) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(
                            .linearGradient(
                                colors: [.blue, .purple],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                    Text("Autopod")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if sidebarSelection == .featureOverview {
                if let feature = selectedFeature {
                    FeatureDetailPanelView(feature: feature) { related in
                        selectedFeature = related
                    }
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 36))
                            .foregroundStyle(.tertiary)
                        Text("Select a feature")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if let session = selectedSession {
                DetailPanelView(
                    session: session,
                    events: selectedSessionEvents,
                    actions: wiredActions,
                    diffString: sessionDiffs[session.id],
                    terminalState: terminalState,
                    terminalDataPipe: terminalDataPipe,
                    onTerminalSendData: onTerminalSendData,
                    onTerminalResize: onTerminalResize,
                    onTerminalConnect: { onTerminalConnect?(session.id) },
                    onTerminalDisconnect: onTerminalDisconnect,
                    onRefreshDiff: { onRefreshDiff?(session.id) },
                    loadFiles: loadFiles,
                    loadContent: loadContent,
                    isLoadingLogs: isLoadingLogs,
                    logsLoadError: logsLoadError,
                    onReloadLogs: onReloadLogs,
                    requestedTab: $requestedDetailTab
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
            Picker("", selection: $sortOrder) {
                ForEach(SortOrder.allCases, id: \.self) { order in
                    Text(order.rawValue).tag(order)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
            if viewMode == .cards {
                Picker("", selection: $cardDensity) {
                    Text("Compact").tag(CardDensity.compact)
                    Text("Detailed").tag(CardDensity.detailed)
                }
                .pickerStyle(.segmented)
                .frame(width: 150)
            }
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
                columns: [GridItem(.adaptive(minimum: 260), spacing: 10)],
                alignment: .leading,
                spacing: 10
            ) {
                ForEach(filteredSessions) { session in
                    SessionCardFinal(session: session, actions: wiredActions, density: cardDensity)
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

}

// MARK: - View mode

enum ViewMode: String {
    case cards, list
}

// MARK: - Sort order

enum SortOrder: String, CaseIterable {
    case created = "Created"
    case lastActive = "Last Active"
}

// MARK: - Session list row (compact list view)

struct SessionListRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: session.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.id)
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
