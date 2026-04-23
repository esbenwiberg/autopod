import AutopodClient
import SwiftUI

/// Root view — three-column layout: Sidebar | Fleet/List | Detail
public struct MainView: View {
    public var pods: [Pod]
    public var scheduledJobs: [ScheduledJob]
    public var isConnected: Bool
    public var connectionLabel: String
    public var connectionState: String
    public var isLoading: Bool
    public var actions: PodActions
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
    public var loadQuality: ((String) async throws -> PodQualitySignals)?
    public var loadQualityScores: (() async throws -> [PodQualityScore])?

    // Scheduled Jobs
    public var onRunCatchup: ((ScheduledJob) -> Void)?
    public var onSkipCatchup: ((ScheduledJob) -> Void)?
    public var onTriggerJob: ((ScheduledJob) -> Void)?
    public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?
    public var onEditJob: ((String, UpdateScheduledJobRequest) -> Void)?
    public var onDeleteJob: ((ScheduledJob) -> Void)?

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
        pods: [Pod] = MockData.all,
        scheduledJobs: [ScheduledJob] = [],
        selectedSessionId: Binding<String?> = .constant(nil),
        isConnected: Bool = true,
        connectionLabel: String = "localhost:3000",
        connectionState: String = "Connected",
        isLoading: Bool = false,
        actions: PodActions = .preview,
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
        loadQuality: ((String) async throws -> PodQualitySignals)? = nil,
        loadQualityScores: (() async throws -> [PodQualityScore])? = nil,
        onRunCatchup: ((ScheduledJob) -> Void)? = nil,
        onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
        onTriggerJob: ((ScheduledJob) -> Void)? = nil,
        onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil,
        onEditJob: ((String, UpdateScheduledJobRequest) -> Void)? = nil,
        onDeleteJob: ((ScheduledJob) -> Void)? = nil,
        memoryEntries: [MemoryEntry] = [],
        pendingMemoryCount: Int = 0,
        onApproveMemory: @escaping (String) -> Void = { _ in },
        onRejectMemory: @escaping (String) -> Void = { _ in },
        onDeleteMemory: @escaping (String) -> Void = { _ in },
        onEditMemory: ((String, String) -> Void)? = nil,
        onCreateMemory: ((MemoryScope, String?, String, String) -> Void)? = nil,
        onLoadMemories: (() async -> Void)? = nil
    ) {
        self.pods = pods
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
        self.loadQuality = loadQuality
        self.loadQualityScores = loadQualityScores
        self.onRunCatchup = onRunCatchup
        self.onSkipCatchup = onSkipCatchup
        self.onTriggerJob = onTriggerJob
        self.onCreateJob = onCreateJob
        self.onEditJob = onEditJob
        self.onDeleteJob = onDeleteJob
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
    @State private var showDeleteSeriesConfirmation = false
    @State private var showCreateSheet = false
    @State private var showCreateSeriesSheet = false
    @State private var showCommandPalette = false
    @State private var pipelineExpanded = true
    @State private var spawnFollowUpInitiator: Pod?
    /// When set, the Create Series sheet opens pre-filled with this pod's
    /// branch as baseBranch (launching a series from an interactive pod).
    @State private var seriesFromPod: Pod?
    @State private var viewMode: ViewMode = .cards
    @State private var cardDensity: CardDensity = .detailed
    @State private var sortOrder: SortOrder = .created
    @State private var selectedFeature: FeatureCategory?
    @State private var requestedDetailTab: DetailTab?

    private var selectedSession: Pod? {
        pods.first { $0.id == selectedSessionId }
    }

    /// Actions with `attachTerminal` wired to navigate + connect.
    private var wiredActions: PodActions {
        var a = actions
        a.attachTerminal = { [onTerminalConnect] podId in
            let wasAlreadySelected = selectedSessionId == podId
            selectedSessionId = podId
            if wasAlreadySelected {
                requestedDetailTab = .terminal
            } else {
                // DetailPanelView is freshly created — delay so onChange can observe the change.
                DispatchQueue.main.async { requestedDetailTab = .terminal }
            }
            onTerminalConnect?(podId)
        }
        return a
    }

    private var filteredSessions: [Pod] {
        let filtered: [Pod] = switch sidebarSelection {
        case .attention:      pods.filter { $0.status.needsAttention && $0.seriesId == nil }
        case .active:         pods.filter { ($0.status.isActive || $0.status.needsAttention) && !$0.isWorkspace && $0.seriesId == nil }
        case .running:        pods.filter { $0.status.isActive && !$0.isWorkspace && $0.seriesId == nil }
        case .workspaces:     pods.filter { $0.isWorkspace && $0.seriesId == nil }
        case .completed:      pods.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace && $0.seriesId == nil }
        case .all:            pods.filter { $0.seriesId == nil }
        case .analytics:        []
        case .history:          []
        case .memory:           []
        case .scheduledJobs:    []
        case .featureOverview:  []
        case .salesPitch:       []
        case .profile(let p):   pods.filter { $0.profileName == p }
        case .series(let id):   pods.filter { $0.seriesId == id }
        case .seriesAll:        Self.seriesRepresentatives(pods)
        }
        return filtered.sorted { a, b in
            switch sortOrder {
            case .created:    a.startedAt > b.startedAt
            case .lastActive: a.updatedAt > b.updatedAt
            }
        }
    }

    /// One pod per unique seriesId — the root (no parents) or earliest-created fallback.
    /// Lets the Series list show one row per series instead of one per brief.
    static func seriesRepresentatives(_ pods: [Pod]) -> [Pod] {
        let grouped = Dictionary(grouping: pods.filter { $0.seriesId != nil }, by: { $0.seriesId! })
        return grouped.values.compactMap { group in
            group.first(where: { $0.dependsOnPodIds.isEmpty })
                ?? group.min(by: { $0.startedAt < $1.startedAt })
        }
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(
                pods: pods,
                selection: $sidebarSelection,
                showCreateSheet: $showCreateSheet,
                showCreateSeriesSheet: $showCreateSeriesSheet,
                isConnected: isConnected,
                connectionLabel: connectionLabel,
                pendingMemoryCount: pendingMemoryCount,
                scheduledJobCount: scheduledJobs.count,
                catchupPendingCount: scheduledJobs.filter { $0.catchupPending }.count,
                onShowSettings: onShowSettings
            )
        } content: {
            if sidebarSelection == .analytics {
                AnalyticsView(
                    pods: pods,
                    loadScores: loadQualityScores,
                    onSelectPod: { podId in
                        sidebarSelection = .all
                        selectedSessionId = podId
                    }
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .history {
                HistoryView(pods: pods, actions: wiredActions, profileNames: profileNames)
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
                        case .pod:
                            guard let s = pods.first(where: { $0.id == id }) else { return id }
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
                    profileNames: profileNames,
                    onRunCatchup: onRunCatchup,
                    onSkipCatchup: onSkipCatchup,
                    onTriggerJob: onTriggerJob,
                    onCreateJob: onCreateJob,
                    onEditJob: onEditJob,
                    onDeleteJob: onDeleteJob
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
                    if case .series(let seriesId) = sidebarSelection {
                        seriesPipelineHeader(seriesId: seriesId)
                        Divider()
                    }
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
            } else if let pod = selectedSession {
                DetailPanelView(
                    pod: pod,
                    events: selectedSessionEvents,
                    actions: wiredActions,
                    seriesPods: pod.seriesId.map { sid in pods.filter { $0.seriesId == sid } } ?? [],
                    onSelectPod: { selectedSessionId = $0 },
                    diffString: sessionDiffs[pod.id],
                    terminalState: terminalState,
                    terminalDataPipe: terminalDataPipe,
                    onTerminalSendData: onTerminalSendData,
                    onTerminalResize: onTerminalResize,
                    onTerminalConnect: { onTerminalConnect?(pod.id) },
                    onTerminalDisconnect: onTerminalDisconnect,
                    onRefreshDiff: { onRefreshDiff?(pod.id) },
                    loadFiles: loadFiles,
                    loadContent: loadContent,
                    loadQuality: loadQuality,
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
        .sheet(isPresented: $showCreateSeriesSheet) {
            CreateSeriesSheet(
                isPresented: $showCreateSeriesSheet,
                actions: actions,
                profileNames: profileNames,
                onSeriesCreated: { seriesId in
                    sidebarSelection = .series(seriesId)
                }
            )
        }
        .sheet(item: $seriesFromPod) { initiator in
            CreateSeriesSheet(
                isPresented: Binding(
                    get: { seriesFromPod != nil },
                    set: { if !$0 { seriesFromPod = nil } }
                ),
                actions: actions,
                profileNames: profileNames,
                initialBaseBranch: initiator.branch,
                initialProfile: initiator.profileName,
                onSeriesCreated: { seriesId in
                    seriesFromPod = nil
                    sidebarSelection = .series(seriesId)
                }
            )
        }
        .sheet(item: $spawnFollowUpInitiator) { initiator in
            SpawnDependentSheet(
                isPresented: Binding(
                    get: { spawnFollowUpInitiator != nil },
                    set: { if !$0 { spawnFollowUpInitiator = nil } }
                ),
                initiator: initiator,
                candidatePods: pods,
                actions: actions,
                profileNames: profileNames,
                onPodCreated: { newId in
                    selectedSessionId = newId
                }
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
                        pods: pods,
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

    // MARK: - Series pipeline (above the fleet grid when a series is selected)

    @ViewBuilder
    private func seriesPipelineHeader(seriesId: String) -> some View {
        let seriesPods = pods.filter { $0.seriesId == seriesId }
        if !seriesPods.isEmpty {
            DisclosureGroup(isExpanded: $pipelineExpanded) {
                SeriesPipelineView(
                    pods: seriesPods,
                    selectedPodId: selectedSessionId,
                    onSelectPod: { selectedSessionId = $0 }
                )
                .frame(minHeight: 180, maxHeight: 360)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "rectangle.3.group.fill")
                        .foregroundStyle(Color.accentColor)
                    Text(seriesPods.first?.seriesName ?? seriesId)
                        .font(.system(.subheadline).weight(.semibold))
                    Text("pipeline")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(seriesPods.count) pods")
                        .font(.system(.caption2).weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.accentColor.opacity(0.1))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(Capsule())
                    Button(role: .destructive) {
                        showDeleteSeriesConfirmation = true
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(.red.opacity(0.8))
                    }
                    .buttonStyle(.plain)
                    .confirmationDialog(
                        "Delete \"\(seriesPods.first?.seriesName ?? seriesId)\"?",
                        isPresented: $showDeleteSeriesConfirmation
                    ) {
                        Button("Delete Series", role: .destructive) {
                            Task {
                                await actions.deleteSeries(seriesId)
                                sidebarSelection = .attention
                            }
                        }
                    } message: {
                        Text("Kills all running pods and permanently removes all \(seriesPods.count) pods in this series.")
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    // MARK: - Content area (cards or list)

    @ViewBuilder
    private var contentArea: some View {
        if isLoading && pods.isEmpty {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading pods…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if pods.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "tray")
                    .font(.system(size: 32))
                    .foregroundStyle(.tertiary)
                Text("No pods")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Create a pod to get started")
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
                ForEach(filteredSessions) { pod in
                    SessionCardFinal(
                        pod: pod,
                        actions: wiredActions,
                        density: cardDensity,
                        isSelected: selectedSessionId == pod.id,
                        onSpawnFollowUp: { spawnFollowUpInitiator = $0 },
                        onLaunchSeriesFromPod: { seriesFromPod = $0 }
                    )
                    .onTapGesture { selectedSessionId = pod.id }
                }
            }
            .padding(16)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sessionList: some View {
        List(filteredSessions, selection: $selectedSessionId) { pod in
            SessionListRow(pod: pod)
                .tag(pod.id)
        }
        .listStyle(.inset)
    }

    // MARK: - Empty detail

    private var emptyDetail: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.on.rectangle.slash")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("Select a pod")
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

// MARK: - Pod list row (compact list view)

struct SessionListRow: View {
    let pod: Pod

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: pod.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(pod.id)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                Text(pod.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let diff = pod.diffStats {
                HStack(spacing: 3) {
                    Text("+\(diff.added)")
                        .foregroundStyle(.green)
                    Text("-\(diff.removed)")
                        .foregroundStyle(.red)
                }
                .font(.system(.caption2, design: .monospaced))
            }
            Text(pod.duration)
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
