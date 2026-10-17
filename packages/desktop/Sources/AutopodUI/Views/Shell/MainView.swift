import AutopodClient
import SwiftUI

/// Root view — three-column layout: Sidebar | Fleet/List | Detail
public struct MainView: View {
    public var pods: [Pod]
    public var managedPods: [ManagedPodSummary]
    public var managedPodAPI: DaemonAPI?
    @Binding public var selectedManagedPodId: String?
    public var managedPodsLoading: Bool
    public var managedPodsError: String?
    public var onRefreshManagedPods: (() async -> Void)?
    public var scheduledJobs: [ScheduledJob]
    public var scheduledJobTemplates: [ScheduledJobTemplate]
    public var isConnected: Bool
    public var connectionLabel: String
    public var connectionState: String
    public var activityStreamConnected: Bool
    public var isLoading: Bool
    public var actions: PodActions
    public var profileNames: [String]
    /// Full profile objects. Optional — used by the create-pod sheet to drive
    /// per-profile UI (e.g. the Dagger sidecar toggle). Empty = name-only fallback.
    public var profileDetails: [Profile]
    public var configurationActions: LaunchConfigurationActions?
    public var selectedSessionEvents: [AgentEvent]
    /// Returns the cached event stream for any pod id — used by the Series tab
    /// slide-in panel so it can show events for sibling pods without making the
    /// whole view observe `EventStream.sessionEvents` mutations.
    public var eventsForPod: ((String) -> [AgentEvent])?
    /// Triggers a historical event fetch for a pod whose events haven't been
    /// loaded yet (e.g. when the user opens the slide-in panel for a sibling).
    public var loadEventsForPod: ((String) -> Void)?
    /// Returns the historical REST load state for a pod's cached events.
    public var relatedEventLoadStateForPod: ((String) -> RelatedEventLoadState)?
    public var isLoadingLogs: Bool
    public var logsLoadError: String?
    public var limitedLogCount: Int?
    public var onReloadLogs: (() -> Void)?
    public var onLoadAllLogs: (() -> Void)?
    public var sessionDiffs: [String: DiffApiResponse]
    public var terminalState: String
    public var terminalDataPipe: TerminalDataPipe?
    public var onTerminalSendData: (([UInt8]) -> Void)?
    public var onTerminalResize: ((Int, Int) -> Void)?
    public var onTerminalConnect: ((String) -> Void)?
    public var onTerminalDisconnect: (() -> Void)?
    public var loadError: String?
    public var onRefresh: (() async -> Void)?
    public var onSelectSession: ((String?) -> Void)?
    public var onRefreshDiff: ((String) -> Void)?
    public var onShowSettings: (() -> Void)?
    public var onEditProfile: ((String) -> Void)?
    public var loadFiles: ((String) async throws -> [SessionFileEntry])?
    public var loadArtifacts: ((String) async throws -> [SessionFileEntry])?
    public var loadContent: ((String, String) async throws -> SessionFileContent)?
    public var loadQuality: ((String) async throws -> PodQualitySignals)?
    public var loadCost: ((String) async throws -> PodCostBreakdownResponse)?
    public var loadPreviewStatus: ((String) async throws -> PreviewStatus)?
    public var loadValidationHistory: ((String) async throws -> [StoredValidationResponse])?
    public var loadFirewallDenials: ((String, String?) async throws -> [FirewallDenialResponse])?
    public var loadActionAudit: ((String, String?) async throws -> ActionAuditResponse)?
    public var loadQualityScores: (() async throws -> [PodQualityScore])?
    public var loadCostAnalytics: (() async throws -> CostAnalyticsResponse)?
    public var loadReliabilityAnalytics: (() async throws -> ReliabilityAnalyticsResponse)?
    public var loadQualityAnalytics: ((Int) async throws -> QualityAnalyticsResponse)?
    public var loadSafetyAnalytics: ((Int) async throws -> SafetyAnalyticsResponse)?
    public var loadThroughputAnalytics: ((Int) async throws -> ThroughputAnalyticsResponse)?
    public var loadEscalationsAnalytics: ((Int) async throws -> EscalationsAnalyticsResponse)?
    public var loadModelsAnalytics: ((Int) async throws -> ModelsAnalyticsResponse)?
    public var loadMemoryAnalytics: ((Int) async throws -> MemoryAnalyticsResponse)?
    public var verifyAuditChain: (() async throws -> AuditChainVerifyResponse)?
    /// Per-pod persisted quality scores keyed by pod id. Used to render the
    /// score pill on completed pod cards. Empty when scores haven't loaded yet.
    public var qualityScores: [String: PodQualityScore]

    // Scheduled Jobs
    public var onRunCatchup: ((ScheduledJob) -> Void)?
    public var onSkipCatchup: ((ScheduledJob) -> Void)?
    public var onOpenScanReports: ((ScheduledJob) -> Void)?
  public var onTriggerJob: ((ScheduledJob) -> Void)?
    public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?
    public var onEditJob: ((String, UpdateScheduledJobRequest) -> Void)?
    public var onDeleteJob: ((ScheduledJob) -> Void)?
    public var onCreateJobTemplate: ((CreateScheduledJobTemplateRequest) -> Void)?
    public var onEditJobTemplate: ((String, UpdateScheduledJobTemplateRequest) -> Void)?
    public var onDeleteJobTemplate: ((ScheduledJobTemplate) -> Void)?

    // Memory
    public var memoryEntries: [MemoryEntry]
    public var activeMemories: [MemoryEntry]
    public var pendingMemoryCandidates: [MemoryCandidate]
    public var memoryExtractionAttempts: [MemoryExtractionAttempt]
    public var selectedMemoryUsage: [MemoryUsageEvent]
    public var selectedMemorySourceEvidence: [MemorySourceEvidence]
    public var selectedMemoryStaleEvidence: [MemoryUsageEvent]
    public var selectedMemoryHarmfulEvidence: [MemoryUsageEvent]
    public var selectedMemoryDetailId: String?
    public var selectedMemoryCandidateDetailId: String?
    public var memoryAnalytics: MemoryAnalyticsResponse?
    public var isLoadingMemoryDetails: Bool
    public var memoryError: String?
    public var pendingMemoryCount: Int
    public var onApproveMemory: (String) -> Void
    public var onRejectMemory: (String) -> Void
    public var onDeleteMemory: (String) -> Void
    public var onEditMemory: ((String, String) -> Void)?
    public var onApproveMemoryCandidate: (String) -> Void
    public var onRejectMemoryCandidate: (String) -> Void
    public var onEditMemoryCandidate: ((String, MemoryCandidateUpdate) -> Void)?
    public var onSelectMemory: ((String) -> Void)?
    public var onSelectMemoryCandidate: ((String) -> Void)?
    public var onCreateMemory: ((MemoryScope, String?, String, String) -> Void)?
    public var onLoadMemories: (() async -> Void)?

    @Binding public var selectedSessionId: String?

    public init(
        pods: [Pod] = MockData.all,
        managedPods: [ManagedPodSummary] = [],
        managedPodAPI: DaemonAPI? = nil,
        selectedManagedPodId: Binding<String?> = .constant(nil),
        managedPodsLoading: Bool = false,
        managedPodsError: String? = nil,
        onRefreshManagedPods: (() async -> Void)? = nil,
        scheduledJobs: [ScheduledJob] = [],
        scheduledJobTemplates: [ScheduledJobTemplate] = [],
        selectedSessionId: Binding<String?> = .constant(nil),
        isConnected: Bool = true,
        connectionLabel: String = "localhost:3000",
        connectionState: String = "Connected",
        activityStreamConnected: Bool = false,
        isLoading: Bool = false,
        actions: PodActions = .preview,
        profileNames: [String] = ["my-app", "webapp", "backend"],
        profileDetails: [Profile] = [],
        configurationActions: LaunchConfigurationActions? = nil,
        selectedSessionEvents: [AgentEvent] = [],
        eventsForPod: ((String) -> [AgentEvent])? = nil,
        loadEventsForPod: ((String) -> Void)? = nil,
        relatedEventLoadStateForPod: ((String) -> RelatedEventLoadState)? = nil,
        isLoadingLogs: Bool = false,
        logsLoadError: String? = nil,
        limitedLogCount: Int? = nil,
        onReloadLogs: (() -> Void)? = nil,
        onLoadAllLogs: (() -> Void)? = nil,
        sessionDiffs: [String: DiffApiResponse] = [:],
        terminalState: String = "disconnected",
        terminalDataPipe: TerminalDataPipe? = nil,
        onTerminalSendData: (([UInt8]) -> Void)? = nil,
        onTerminalResize: ((Int, Int) -> Void)? = nil,
        onTerminalConnect: ((String) -> Void)? = nil,
        onTerminalDisconnect: (() -> Void)? = nil,
        loadError: String? = nil,
        onRefresh: (() async -> Void)? = nil,
        onSelectSession: ((String?) -> Void)? = nil,
        onRefreshDiff: ((String) -> Void)? = nil,
        onShowSettings: (() -> Void)? = nil,
        onEditProfile: ((String) -> Void)? = nil,
        loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
        loadArtifacts: ((String) async throws -> [SessionFileEntry])? = nil,
        loadContent: ((String, String) async throws -> SessionFileContent)? = nil,
        loadQuality: ((String) async throws -> PodQualitySignals)? = nil,
        loadCost: ((String) async throws -> PodCostBreakdownResponse)? = nil,
        loadPreviewStatus: ((String) async throws -> PreviewStatus)? = nil,
        loadValidationHistory: ((String) async throws -> [StoredValidationResponse])? = nil,
        loadFirewallDenials: ((String, String?) async throws -> [FirewallDenialResponse])? = nil,
        loadActionAudit: ((String, String?) async throws -> ActionAuditResponse)? = nil,
        loadQualityScores: (() async throws -> [PodQualityScore])? = nil,
        loadCostAnalytics: (() async throws -> CostAnalyticsResponse)? = nil,
        loadReliabilityAnalytics: (() async throws -> ReliabilityAnalyticsResponse)? = nil,
        loadQualityAnalytics: ((Int) async throws -> QualityAnalyticsResponse)? = nil,
        loadSafetyAnalytics: ((Int) async throws -> SafetyAnalyticsResponse)? = nil,
        loadThroughputAnalytics: ((Int) async throws -> ThroughputAnalyticsResponse)? = nil,
        loadEscalationsAnalytics: ((Int) async throws -> EscalationsAnalyticsResponse)? = nil,
        loadModelsAnalytics: ((Int) async throws -> ModelsAnalyticsResponse)? = nil,
        loadMemoryAnalytics: ((Int) async throws -> MemoryAnalyticsResponse)? = nil,
        verifyAuditChain: (() async throws -> AuditChainVerifyResponse)? = nil,
        qualityScores: [String: PodQualityScore] = [:],
        onRunCatchup: ((ScheduledJob) -> Void)? = nil,
        onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
        onOpenScanReports: ((ScheduledJob) -> Void)? = nil,
    onTriggerJob: ((ScheduledJob) -> Void)? = nil,
        onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil,
        onEditJob: ((String, UpdateScheduledJobRequest) -> Void)? = nil,
        onDeleteJob: ((ScheduledJob) -> Void)? = nil,
        onCreateJobTemplate: ((CreateScheduledJobTemplateRequest) -> Void)? = nil,
        onEditJobTemplate: ((String, UpdateScheduledJobTemplateRequest) -> Void)? = nil,
        onDeleteJobTemplate: ((ScheduledJobTemplate) -> Void)? = nil,
        memoryEntries: [MemoryEntry] = [],
        activeMemories: [MemoryEntry] = [],
        pendingMemoryCandidates: [MemoryCandidate] = [],
        memoryExtractionAttempts: [MemoryExtractionAttempt] = [],
        selectedMemoryUsage: [MemoryUsageEvent] = [],
        selectedMemorySourceEvidence: [MemorySourceEvidence] = [],
        selectedMemoryStaleEvidence: [MemoryUsageEvent] = [],
        selectedMemoryHarmfulEvidence: [MemoryUsageEvent] = [],
        selectedMemoryDetailId: String? = nil,
        selectedMemoryCandidateDetailId: String? = nil,
        memoryAnalytics: MemoryAnalyticsResponse? = nil,
        isLoadingMemoryDetails: Bool = false,
        memoryError: String? = nil,
        pendingMemoryCount: Int = 0,
        onApproveMemory: @escaping (String) -> Void = { _ in },
        onRejectMemory: @escaping (String) -> Void = { _ in },
        onDeleteMemory: @escaping (String) -> Void = { _ in },
        onEditMemory: ((String, String) -> Void)? = nil,
        onApproveMemoryCandidate: @escaping (String) -> Void = { _ in },
        onRejectMemoryCandidate: @escaping (String) -> Void = { _ in },
        onEditMemoryCandidate: ((String, MemoryCandidateUpdate) -> Void)? = nil,
        onSelectMemory: ((String) -> Void)? = nil,
        onSelectMemoryCandidate: ((String) -> Void)? = nil,
        onCreateMemory: ((MemoryScope, String?, String, String) -> Void)? = nil,
        onLoadMemories: (() async -> Void)? = nil
    ) {
        self.pods = pods
        self.managedPods = managedPods
        self.managedPodAPI = managedPodAPI
        self._selectedManagedPodId = selectedManagedPodId
        self.managedPodsLoading = managedPodsLoading
        self.managedPodsError = managedPodsError
        self.onRefreshManagedPods = onRefreshManagedPods
        self.scheduledJobs = scheduledJobs
        self.scheduledJobTemplates = scheduledJobTemplates
        self._selectedSessionId = selectedSessionId
        self.isConnected = isConnected
        self.connectionLabel = connectionLabel
        self.connectionState = connectionState
        self.activityStreamConnected = activityStreamConnected
        self.isLoading = isLoading
        self.actions = actions
        self.profileNames = profileNames
        self.profileDetails = profileDetails
        self.configurationActions = configurationActions
        self.selectedSessionEvents = selectedSessionEvents
        self.eventsForPod = eventsForPod
        self.loadEventsForPod = loadEventsForPod
        self.relatedEventLoadStateForPod = relatedEventLoadStateForPod
        self.isLoadingLogs = isLoadingLogs
        self.logsLoadError = logsLoadError
        self.limitedLogCount = limitedLogCount
        self.onReloadLogs = onReloadLogs
        self.onLoadAllLogs = onLoadAllLogs
        self.sessionDiffs = sessionDiffs
        self.terminalState = terminalState
        self.terminalDataPipe = terminalDataPipe
        self.onTerminalSendData = onTerminalSendData
        self.onTerminalResize = onTerminalResize
        self.onTerminalConnect = onTerminalConnect
        self.onTerminalDisconnect = onTerminalDisconnect
        self.loadError = loadError
        self.onRefresh = onRefresh
        self.onSelectSession = onSelectSession
        self.onRefreshDiff = onRefreshDiff
        self.onShowSettings = onShowSettings
        self.onEditProfile = onEditProfile
        self.loadFiles = loadFiles
        self.loadArtifacts = loadArtifacts
        self.loadContent = loadContent
        self.loadQuality = loadQuality
        self.loadCost = loadCost
        self.loadPreviewStatus = loadPreviewStatus
        self.loadValidationHistory = loadValidationHistory
        self.loadFirewallDenials = loadFirewallDenials
        self.loadActionAudit = loadActionAudit
        self.loadQualityScores = loadQualityScores
        self.loadCostAnalytics = loadCostAnalytics
        self.loadReliabilityAnalytics = loadReliabilityAnalytics
        self.loadQualityAnalytics = loadQualityAnalytics
        self.loadSafetyAnalytics = loadSafetyAnalytics
        self.loadThroughputAnalytics = loadThroughputAnalytics
        self.loadEscalationsAnalytics = loadEscalationsAnalytics
        self.loadModelsAnalytics = loadModelsAnalytics
        self.loadMemoryAnalytics = loadMemoryAnalytics
        self.verifyAuditChain = verifyAuditChain
        self.qualityScores = qualityScores
        self.onRunCatchup = onRunCatchup
        self.onSkipCatchup = onSkipCatchup
        self.onOpenScanReports = onOpenScanReports
    self.onTriggerJob = onTriggerJob
        self.onCreateJob = onCreateJob
        self.onEditJob = onEditJob
        self.onDeleteJob = onDeleteJob
        self.onCreateJobTemplate = onCreateJobTemplate
        self.onEditJobTemplate = onEditJobTemplate
        self.onDeleteJobTemplate = onDeleteJobTemplate
        self.memoryEntries = memoryEntries
        self.activeMemories = activeMemories
        self.pendingMemoryCandidates = pendingMemoryCandidates
        self.memoryExtractionAttempts = memoryExtractionAttempts
        self.selectedMemoryUsage = selectedMemoryUsage
        self.selectedMemorySourceEvidence = selectedMemorySourceEvidence
        self.selectedMemoryStaleEvidence = selectedMemoryStaleEvidence
        self.selectedMemoryHarmfulEvidence = selectedMemoryHarmfulEvidence
        self.selectedMemoryDetailId = selectedMemoryDetailId
        self.selectedMemoryCandidateDetailId = selectedMemoryCandidateDetailId
        self.memoryAnalytics = memoryAnalytics
        self.isLoadingMemoryDetails = isLoadingMemoryDetails
        self.memoryError = memoryError
        self.pendingMemoryCount = pendingMemoryCount
        self.onApproveMemory = onApproveMemory
        self.onRejectMemory = onRejectMemory
        self.onDeleteMemory = onDeleteMemory
        self.onEditMemory = onEditMemory
        self.onApproveMemoryCandidate = onApproveMemoryCandidate
        self.onRejectMemoryCandidate = onRejectMemoryCandidate
        self.onEditMemoryCandidate = onEditMemoryCandidate
        self.onSelectMemory = onSelectMemory
        self.onSelectMemoryCandidate = onSelectMemoryCandidate
        self.onCreateMemory = onCreateMemory
        self.onLoadMemories = onLoadMemories
    }

    @State private var sidebarSelection: SidebarItem = DesktopIdentity.isPreview ? .all : .attention
    @AppStorage("autopod.desktop.redesign") private var redesign = DesktopIdentity.isPreview
    @State private var repositoryID: String?
    @State private var villageSelectedSource: VillageActor.Source = .native
    @State private var villageShowsDetails = false
    @State private var villageSearch = ""
    @Environment(\.accessibilityReduceMotion) private var villageReducedMotion
    @State private var showDeleteSeriesConfirmation = false
    @State private var showCreateSheet = false
    @State private var showCreateSeriesSheet = false
    @State private var showCommandPalette = false
    @State private var selectedDesktopSeriesID: String?
    @State private var pipelineExpanded = true
    @State private var spawnFollowUpInitiator: Pod?
    /// When set, the Create Series sheet opens pre-filled with this pod's
    /// branch as baseBranch (launching a series from an interactive pod).
    @State private var seriesFromPod: Pod?
    @State private var viewMode: ViewMode = .cards
    @State private var cardDensity: CardDensity = .detailed
    @State private var sortOrder: SortOrder = .created
    @State private var browseScope: BrowseScope = .recent
    @State private var searchText: String = ""
    @State private var selectedFeature: FeatureCategory?
    @State private var selectedAnalyticsCard: AnalyticsCardKind?
    @State private var selectedDetailTab: DetailTab?
    @State private var requestedDetailTab: DetailTab?

    private var isDesktopSeriesWorkspace: Bool {
        guard redesign else { return false }
        if sidebarSelection == .seriesAll { return true }
        if case .series = sidebarSelection { return true }
        return false
    }

    private var selectedDesktopSeries: DesktopSeriesGroup? {
        let groups = DesktopSeriesGroup.groups(pods, includeCompleted: true)
        let id: String?
        if case .series(let seriesID) = sidebarSelection { id = seriesID }
        else { id = selectedDesktopSeriesID }
        return groups.first { $0.id == id }
    }

    private func openSeriesPod(_ id: String, tab: DetailTab) {
        repositoryID = nil
        sidebarSelection = .all
        selectedSessionId = id
        selectedDetailTab = tab
        requestedDetailTab = tab
    }

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
        Self.visiblePods(
            pods,
            selection: sidebarSelection,
            browseScope: browseScope,
            query: searchText,
            sortOrder: sortOrder,
            selectedPodId: selectedSessionId,
            repositoryID: repositoryID, profiles: profileDetails
        )
    }

    /// Filters pods by a free-text query. Matches against the pod's name (id),
    /// brief title, task description, profile, and series name so users can find
    /// pods by anything they'd recognise on the card. Empty query is a no-op.
    static func searchPods(_ pods: [Pod], query: String, profiles: [Profile] = []) -> [Pod] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return pods }
        return pods.filter { pod in
            (DesktopRepository.resolve(pod, profiles: profiles)?.label.localizedCaseInsensitiveContains(trimmed) ?? false)
                || pod.id.localizedCaseInsensitiveContains(trimmed)
                || (pod.briefTitle?.localizedCaseInsensitiveContains(trimmed) ?? false)
                || pod.task.localizedCaseInsensitiveContains(trimmed)
                || pod.profileName.localizedCaseInsensitiveContains(trimmed)
                || (pod.seriesName?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
    }

    static let defaultBrowseRecentLimit = 50

    /// Pods shown by the Browse sidebar item before search/sort is applied.
    /// Recent mode keeps the default surface actionable and bounded, while
    /// Archive mode and search both use the full loaded archive.
    static func browsePods(
        _ pods: [Pod],
        scope: BrowseScope,
        query: String = "",
        selectedPodId: String? = nil,
        limit: Int = defaultBrowseRecentLimit
    ) -> [Pod] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard scope == .recent && trimmed.isEmpty else { return pods }

        var result = recentBrowsePods(pods, limit: limit)
        if let selectedPodId,
           !result.contains(where: { $0.id == selectedPodId }),
           let selected = pods.first(where: { $0.id == selectedPodId }) {
            result.append(selected)
        }
        return result
    }

    static func visiblePods(
        _ pods: [Pod],
        selection: SidebarItem,
        browseScope: BrowseScope = .recent,
        query: String = "",
        sortOrder: SortOrder = .created,
        selectedPodId: String? = nil,
        limit: Int = defaultBrowseRecentLimit,
        repositoryID: String? = nil,
        profiles: [Profile] = []
    ) -> [Pod] {
        let scoped = repositoryID.map { id in
            pods.filter { DesktopRepository.resolve($0, profiles: profiles)?.id == id }
        } ?? pods
        let base = selection == .all
            ? browsePods(
                scoped,
                scope: browseScope,
                query: query,
                selectedPodId: selectedPodId,
                limit: limit
            )
            : filterPods(scoped, for: selection)
        return sortPods(searchPods(base, query: query, profiles: profiles), by: sortOrder)
    }

    private static func recentBrowsePods(_ pods: [Pod], limit: Int) -> [Pod] {
        let actionable = pods.filter { ($0.status.isActive || $0.status.needsAttention) && !$0.isWorkspace }
        let actionableIds = Set(actionable.map(\.id))
        let recentLimit = max(0, limit - actionable.count)
        let recent = pods
            .filter { !actionableIds.contains($0.id) }
            .sorted { recentActivityDate($0) > recentActivityDate($1) }
            .prefix(recentLimit)
        return actionable + recent
    }

    private static func recentActivityDate(_ pod: Pod) -> Date {
        var date = max(pod.startedAt, pod.updatedAt)
        if let runningAt = pod.runningAt {
            date = max(date, runningAt)
        }
        return date
    }

    private static func sortPods(_ pods: [Pod], by sortOrder: SortOrder) -> [Pod] {
        pods.sorted { a, b in
            switch sortOrder {
            case .created:    a.startedAt > b.startedAt
            case .lastActive: a.updatedAt > b.updatedAt
            }
        }
    }

    /// Maps a sidebar selection to a filtered pod list.
    /// Extracted as a static helper so unit tests can call it without constructing a full view.
    static func filterPods(_ pods: [Pod], for selection: SidebarItem) -> [Pod] {
        switch selection {
        case .attention:             pods.filter { $0.status.needsAttention }
        case .active:                pods.filter { ($0.status.isActive || $0.status.needsAttention) && !$0.isWorkspace }
        case .running:               pods.filter { $0.status.isActive && !$0.isWorkspace }
        case .workspaces:            pods.filter { $0.isWorkspace }
        case .completed:             pods.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }
        case .all:                   pods
        case .managedPods, .village: []
        case .analytics:             []
        case .history:               []
        case .memory:                []
        case .scheduledJobs:         []
        case .featureOverview:       []
        case .salesPitch:            []
        case .profile(let p):        pods.filter { $0.profileName == p }
        case .series(let id):        pods.filter { $0.seriesId == id }
        case .seriesAll:             seriesRepresentatives(pods)
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
                managedPodCount: managedPods.count,
                onShowSettings: onShowSettings
            )
        } content: {
            Group {
            if sidebarSelection == .village {
                VillageView(
                    snapshotForDate: villageSnapshot,
                    isConnected: isConnected, activityStreamConnected: activityStreamConnected,
                    managedError: managedPodsError,
                    refreshManaged: onRefreshManagedPods,
                    onSelect: selectVillageActor,
                    search: $villageSearch
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .managedPods {
                ManagedPodsView(
                    pods: managedPods,
                    selection: $selectedManagedPodId,
                    isLoading: managedPodsLoading,
                    error: managedPodsError,
                    onRefresh: { await onRefreshManagedPods?() }
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .analytics {
                AnalyticsView(
                    pods: pods,
                    loadScores: loadQualityScores,
                    loadCost: loadCostAnalytics,
                    loadReliability: loadReliabilityAnalytics,
                    loadQualityAnalytics: loadQualityAnalytics,
                    loadSafetyAnalytics: loadSafetyAnalytics,
                    loadThroughputAnalytics: loadThroughputAnalytics,
                    loadEscalationsAnalytics: loadEscalationsAnalytics,
                    loadModelsAnalytics: loadModelsAnalytics,
                    loadMemoryAnalytics: loadMemoryAnalytics,
                    selectedCard: $selectedAnalyticsCard
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .history {
                HistoryView(pods: pods, actions: wiredActions, profileNames: profileNames, configurationActions: configurationActions)
                    .frame(minWidth: 600)
            } else if sidebarSelection == .memory {
                MemoryManagementView(
                    entries: memoryEntries,
                    activeMemories: activeMemories,
                    pendingCandidates: pendingMemoryCandidates,
                    extractionAttempts: memoryExtractionAttempts,
                    selectedUsage: selectedMemoryUsage,
                    selectedSourceEvidence: selectedMemorySourceEvidence,
                    selectedStaleEvidence: selectedMemoryStaleEvidence,
                    selectedHarmfulEvidence: selectedMemoryHarmfulEvidence,
                    selectedMemoryDetailId: selectedMemoryDetailId,
                    selectedCandidateDetailId: selectedMemoryCandidateDetailId,
                    analytics: memoryAnalytics,
                    isLoadingDetails: isLoadingMemoryDetails,
                    error: memoryError,
                    scopeFilter: nil,
                    onApprove: onApproveMemory,
                    onReject: onRejectMemory,
                    onDelete: onDeleteMemory,
                    onEdit: onEditMemory,
                    onApproveCandidate: onApproveMemoryCandidate,
                    onRejectCandidate: onRejectMemoryCandidate,
                    onEditCandidate: onEditMemoryCandidate,
                    onSelectMemory: onSelectMemory,
                    onSelectCandidate: onSelectMemoryCandidate,
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
                        case .repository:
                            return configurationActions?.documents.first(where: { $0.kind == .repository && $0.id == id })?.name ?? id
                        case .profile:
                            return id
                        case .global:
                            return nil
                        case .unknown:
                            return id
                        }
                    },
                    profileNames: profileNames,
                    configurationActions: configurationActions
                )
                .frame(minWidth: 600)
                .task { await onLoadMemories?() }
            } else if sidebarSelection == .scheduledJobs {
                ScheduledJobsView(
                    jobs: scheduledJobs,
                    templates: scheduledJobTemplates,
                    profileNames: profileNames,
                    configurationActions: configurationActions,
                    onRunCatchup: onRunCatchup,
                    onSkipCatchup: onSkipCatchup,
                    onOpenScanReports: onOpenScanReports,
                    onTriggerJob: onTriggerJob,
                    onCreateJob: onCreateJob,
                    onEditJob: onEditJob,
                    onDeleteJob: onDeleteJob,
                    onCreateTemplate: onCreateJobTemplate,
                    onEditTemplate: onEditJobTemplate,
                    onDeleteTemplate: onDeleteJobTemplate
                )
                .frame(minWidth: 600)
            } else if sidebarSelection == .salesPitch {
                SalesPitchView()
                    .frame(minWidth: 600)
            } else if sidebarSelection == .featureOverview {
                FeatureOverviewView(selectedFeature: $selectedFeature)
                    .frame(minWidth: 600)
            } else if isDesktopSeriesWorkspace {
                DesktopSeriesNavigation(pods: pods, selectedID: $selectedDesktopSeriesID)
            } else if sidebarSelection == .seriesAll {
                SeriesListView(
                    pods: pods,
                    selectedPodId: selectedSessionId,
                    onSelectPod: { selectedSessionId = $0 },
                    actions: wiredActions
                )
                .frame(minWidth: 500)
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
                .frame(minWidth: redesign ? 420 : 500)
            }
            }.navigationSplitViewColumnWidth(min: isDesktopSeriesWorkspace ? 260 : 420, ideal: isDesktopSeriesWorkspace ? 300 : 820, max: isDesktopSeriesWorkspace ? 400 : 1500)
        } detail: {
            VStack(spacing: 0) {
                if sidebarSelection == .village && villageShowsDetails {
                    HStack {
                        Button { villageShowsDetails = false } label: {
                            Label("Village pods", systemImage: "chevron.left")
                        }
                        .buttonStyle(.plain)
                        Spacer()
                    }
                    .padding()
                    Divider()
                }
                if sidebarSelection == .village && !villageShowsDetails {
                    TimelineView(.periodic(from: .now, by: 5)) { context in
                        VillagePodListView(snapshot: villageSnapshot(context.date), onSelect: selectVillageActor)
                    }
                } else if sidebarSelection == .managedPods || (sidebarSelection == .village && villageSelectedSource == .managed) {
                    if let pod = managedPods.first(where: { $0.id == selectedManagedPodId }) {
                        ManagedPodDetailView(pod: pod, api: managedPodAPI)
                    } else {
                        VStack(spacing: 10) {
                            Image(systemName: "shippingbox")
                                .font(.system(size: 36))
                                .foregroundStyle(.tertiary)
                            Text("Select a managed pod")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else if sidebarSelection == .analytics {
                    AnalyticsRightPaneView(
                        card: selectedAnalyticsCard,
                        pods: pods,
                        loadScores: loadQualityScores,
                        loadCost: loadCostAnalytics,
                        loadReliability: loadReliabilityAnalytics,
                        loadQuality: loadQualityAnalytics,
                        loadSafety: loadSafetyAnalytics,
                        loadThroughput: loadThroughputAnalytics,
                        loadEscalations: loadEscalationsAnalytics,
                        loadModels: loadModelsAnalytics,
                        loadMemory: loadMemoryAnalytics,
                        verifyAuditChain: verifyAuditChain,
                        onSelectPod: { sessionId in
                            let result = Self.analyticsSelectPodResult(sessionId: sessionId)
                            selectedAnalyticsCard = result.card
                            sidebarSelection = result.sidebar
                            selectedSessionId = result.session
                        },
                        onQualitySelectPod: { sessionId in
                            let result = Self.analyticsSelectPodResult(sessionId: sessionId)
                            selectedAnalyticsCard = result.card
                            sidebarSelection = result.sidebar
                            selectedSessionId = result.session
                            requestedDetailTab = .work
                        },
                        onSafetySelectPod: { sessionId in
                            let result = Self.analyticsSelectPodResult(sessionId: sessionId)
                            selectedAnalyticsCard = result.card
                            sidebarSelection = result.sidebar
                            selectedSessionId = result.session
                            requestedDetailTab = .work
                        },
                        onThroughputSelectPod: { sessionId in
                            let result = Self.analyticsSelectPodResult(sessionId: sessionId)
                            selectedAnalyticsCard = result.card
                            sidebarSelection = result.sidebar
                            selectedSessionId = result.session
                            requestedDetailTab = .work
                        },
                        onEscalationsSelectPod: { sessionId in
                            let result = Self.analyticsSelectPodResult(sessionId: sessionId)
                            selectedAnalyticsCard = result.card
                            sidebarSelection = result.sidebar
                            selectedSessionId = result.session
                            requestedDetailTab = .work
                        }
                    )
                } else if sidebarSelection == .salesPitch {
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
                } else if isDesktopSeriesWorkspace {
                    if let group = selectedDesktopSeries {
                        DesktopSeriesWorkspace(group: group, qualityScores: qualityScores, actions: wiredActions,
                            eventsForPod: eventsForPod, loadEventsForPod: loadEventsForPod,
                            loadQuality: loadQuality, openPod: openSeriesPod)
                    } else {
                        ContentUnavailableView("Select a series", systemImage: "rectangle.3.group")
                    }
                } else if let pod = selectedSession {
                    DetailPanelView(
                        pod: pod,
                        events: selectedSessionEvents,
                        actions: wiredActions,
                        seriesPods: pod.seriesId.map { sid in pods.filter { $0.seriesId == sid } } ?? [],
                        qualityScores: qualityScores,
                        onSelectPod: { selectedSessionId = $0 },
                        eventsForPod: eventsForPod,
                        loadEventsForPod: loadEventsForPod,
                        relatedEventLoadStateForPod: relatedEventLoadStateForPod,
                        diffResponse: sessionDiffs[pod.id],
                        terminalState: terminalState,
                        terminalDataPipe: terminalDataPipe,
                        onTerminalSendData: onTerminalSendData,
                        onTerminalResize: onTerminalResize,
                        onTerminalConnect: { onTerminalConnect?(pod.id) },
                        onTerminalDisconnect: onTerminalDisconnect,
                        onRefreshDiff: { onRefreshDiff?(pod.id) },
                        loadFiles: loadFiles,
                        loadArtifacts: loadArtifacts,
                        loadContent: loadContent,
                        loadQuality: loadQuality,
                        loadCost: loadCost,
                        loadPreviewStatus: loadPreviewStatus,
                        loadValidationHistory: loadValidationHistory,
                        loadFirewallDenials: loadFirewallDenials,
                        loadActionAudit: loadActionAudit,
                        isLoadingLogs: isLoadingLogs,
                        logsLoadError: logsLoadError,
                        limitedLogCount: limitedLogCount,
                        onReloadLogs: onReloadLogs,
                        onLoadAllLogs: onLoadAllLogs,
                        onLaunchSeriesFromPod: { seriesFromPod = $0 },
                        selectedTab: $selectedDetailTab,
                        requestedTab: $requestedDetailTab
                    )
                    .id(pod.id)
                } else {
                    emptyDetail
                }
            }
            .navigationSplitViewColumnWidth(min: isDesktopSeriesWorkspace ? 560 : 350, ideal: isDesktopSeriesWorkspace ? 1100 : 720, max: isDesktopSeriesWorkspace ? 1800 : 1400)
        }
        .navigationSplitViewStyle(.balanced)
        .environment(\.desktopRedesign, redesign)
        .environment(\.desktopRepositories, repositoriesByPod)
        .environment(\.desktopRepositoryFilter, { repositoryID = $0 })
        .environment(\.desktopPodSelection, { selectedSessionId = $0 })
        .modifier(DesktopAppearanceModifier())
        .tint(redesign ? DesktopTheme.accent : .accentColor)
        .onChange(of: sidebarSelection) { _, selection in
            if redesign, case .series(let id) = selection {
                selectedDesktopSeriesID = id
                sidebarSelection = .seriesAll
            }
        }
        .onChange(of: redesign) { _, enabled in
            if !enabled { repositoryID = nil }
            else if case .series(let id) = sidebarSelection {
                selectedDesktopSeriesID = id
                sidebarSelection = .seriesAll
            }
        }
        .onChange(of: repositoryID) { _, _ in
            if let selectedSessionId, !filteredSessions.contains(where: { $0.id == selectedSessionId }) {
                self.selectedSessionId = filteredSessions.first?.id
            }
        }
        .onChange(of: connectionLabel) { _, _ in repositoryID = nil }
        .sheet(isPresented: $showCreateSheet) {
            if let configurationActions {
                ComposableCreatePodSheet(isPresented: $showCreateSheet, actions: configurationActions)
            } else {
            CreateSessionSheet(
                isPresented: $showCreateSheet,
                actions: actions,
                profileNames: profileNames,
                profileDetails: profileDetails
            )
            }
        }
        .sheet(isPresented: $showCreateSeriesSheet) {
            CreateSeriesSheet(
                isPresented: $showCreateSeriesSheet,
                actions: actions,
                profileNames: profileNames,
                configurationActions: configurationActions,
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
                configurationActions: configurationActions,
                initialBaseBranch: initiator.branch,
                initialTargetBranch: initiator.baseBranch,
                initialProfile: initiator.profileName,
                initialSyncPodId: initiator.isTerminal ? nil : initiator.id,
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
                configurationActions: configurationActions,
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
                ZStack(alignment: .top) {
                    Color.black.opacity(0.2)
                        .ignoresSafeArea()
                        .onTapGesture { showCommandPalette = false }
                        .allowsHitTesting(true)
                    CommandPalette(
                        isPresented: $showCommandPalette,
                        pods: pods,
                        profiles: profileDetails,
                        actions: actions,
                        onSelectSession: { id in
                            sidebarSelection = .all
                            selectedSessionId = id
                        },
                        onCreatePod: {
                            showCreateSheet = true
                        },
                        onShowProfilePods: { name in
                            searchText = ""
                            sidebarSelection = .profile(name)
                        },
                        onEditProfile: { name in
                            onEditProfile?(name)
                        }
                    )
                    .padding(.top, 80)
                }
            }
        }
        .background {
            // Hidden button to catch Cmd+K
            Button("") { showCommandPalette.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .hidden()
            // Hidden button to catch Cmd+R (refresh pods)
            Button("") { Task { await onRefresh?() } }
                .keyboardShortcut("r", modifiers: .command)
                .hidden()
        }
    }

    // MARK: - Content toolbar

    @ViewBuilder
    private var contentToolbar: some View {
        if redesign { redesignedToolbar } else { legacyToolbar }
    }

    private var repositoriesByPod: [String: DesktopRepository] {
        Dictionary(uniqueKeysWithValues: pods.compactMap { pod in
            DesktopRepository.resolve(pod, profiles: profileDetails).map { (pod.id, $0) }
        })
    }

    private var repositories: [DesktopRepository] {
        Array(Set(repositoriesByPod.values.map(\.id))).compactMap { id in
            repositoriesByPod.values.first { $0.id == id }
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    private var redesignedToolbar: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(sidebarSelection == .all ? "All pods" : sidebarSelection.label)
                        .font(.system(size: 26, weight: .semibold)).tracking(-0.7)
                    Text("\(filteredSessions.count) \(filteredSessions.count == 1 ? "pod" : "pods") · \(repositories.first { $0.id == repositoryID }?.label ?? "All repositories")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button { showCreateSheet = true } label: { Label("New pod", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).controlSize(.regular).keyboardShortcut("n", modifiers: .command)
                Menu {
                    Button("New series") { showCreateSeriesSheet = true }
                    Divider()
                    Picker("View", selection: $viewMode) { Text("Cards").tag(ViewMode.cards); Text("List").tag(ViewMode.list) }
                    Picker("Card density", selection: $cardDensity) {
                        ForEach(CardDensity.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Picker("Sort", selection: $sortOrder) {
                        ForEach(SortOrder.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    if sidebarSelection == .all {
                        Picker("Browse", selection: $browseScope) {
                            ForEach(BrowseScope.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                    }
                    Divider()
                    Button("Refresh") { Task { await onRefresh?() } }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Fleet options")
            }
            HStack(spacing: 10) {
                searchField(width: nil)
                Picker("Repository", selection: $repositoryID) {
                    Text("All repositories").tag(nil as String?)
                    ForEach(repositories) { Text($0.label).tag(Optional($0.id)) }
                }.labelsHidden().controlSize(.regular)
                    .frame(minWidth: 110, idealWidth: 180, maxWidth: 230)
                    .accessibilityLabel("Filter by repository")
                if repositoryID != nil {
                    Button { repositoryID = nil } label: { Image(systemName: "xmark.circle") }
                        .buttonStyle(.plain).help("Clear repository filter")
                }
            }
        }.padding(24).background(DesktopTheme.canvas)
    }

    private var legacyToolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                toolbarTitle
                Spacer(minLength: 8)
                searchField(width: 200)
                toolbarControls(compact: false)
                refreshButton
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    toolbarTitle
                    Spacer(minLength: 8)
                    refreshButton
                }
                HStack(spacing: 8) {
                    searchField(width: nil)
                    toolbarControls(compact: true)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var toolbarTitle: some View {
        HStack(spacing: 8) {
            Text(sidebarSelection.label)
                .font(.headline)
                .lineLimit(1)
                .fixedSize()
            Text("\(filteredSessions.count)")
                .font(.system(.caption2).weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.blue.opacity(0.1))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
                .fixedSize()
        }
    }

    @ViewBuilder
    private func toolbarControls(compact: Bool) -> some View {
        HStack(spacing: 8) {
            if sidebarSelection == .all {
                browseScopePicker(compact: compact)
            }
            sortPicker(compact: compact)
            if viewMode == .cards {
                densityPicker(compact: compact)
            }
            viewModePicker
        }
        .fixedSize()
    }

    private func searchField(width: CGFloat?) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            TextField("Search pods", text: $searchText)
                .textFieldStyle(.plain)
                .font(.caption)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .frame(width: width)
        .frame(maxWidth: width == nil ? .infinity : nil)
    }

    @ViewBuilder
    private func browseScopePicker(compact: Bool) -> some View {
        if compact {
            Menu {
                Picker("Browse", selection: $browseScope) {
                    ForEach(BrowseScope.allCases, id: \.self) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
            } label: {
                Image(systemName: browseScope == .recent ? "clock" : "archivebox")
                    .font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Browse: \(browseScope.rawValue)")
        } else {
            Picker("", selection: $browseScope) {
                ForEach(BrowseScope.allCases, id: \.self) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 150)
        }
    }

    @ViewBuilder
    private func sortPicker(compact: Bool) -> some View {
        if compact {
            Menu {
                Picker("Sort", selection: $sortOrder) {
                    ForEach(SortOrder.allCases, id: \.self) { order in
                        Text(order.rawValue).tag(order)
                    }
                }
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Sort: \(sortOrder.rawValue)")
        } else {
            Picker("", selection: $sortOrder) {
                ForEach(SortOrder.allCases, id: \.self) { order in
                    Text(order.rawValue).tag(order)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
        }
    }

    @ViewBuilder
    private func densityPicker(compact: Bool) -> some View {
        if compact {
            Menu {
                Picker("Density", selection: $cardDensity) {
                    Text("Compact").tag(CardDensity.compact)
                    Text("Detailed").tag(CardDensity.detailed)
                }
            } label: {
                Image(systemName: cardDensity == .compact ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
                    .font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Density: \(cardDensity == .compact ? "Compact" : "Detailed")")
        } else {
            Picker("", selection: $cardDensity) {
                Text("Compact").tag(CardDensity.compact)
                Text("Detailed").tag(CardDensity.detailed)
            }
            .pickerStyle(.segmented)
            .frame(width: 150)
        }
    }

    private var viewModePicker: some View {
        Picker("", selection: $viewMode) {
            Image(systemName: "rectangle.grid.2x2").tag(ViewMode.cards)
            Image(systemName: "list.bullet").tag(ViewMode.list)
        }
        .pickerStyle(.segmented)
        .frame(width: 80)
    }

    private var refreshButton: some View {
        Button {
            Task { await onRefresh?() }
        } label: {
            Image(systemName: isLoading ? "arrow.clockwise" : "arrow.clockwise")
                .rotationEffect(isLoading ? .degrees(360) : .zero)
                .animation(isLoading ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isLoading)
        }
        .buttonStyle(.borderless)
        .help("Refresh pods (⌘R)")
        .disabled(isLoading)
    }

    // MARK: - Series pipeline (above the fleet grid when a series is selected)

    @ViewBuilder
    private func seriesPipelineHeader(seriesId: String) -> some View {
        let seriesPods = pods.filter { $0.seriesId == seriesId }
        if !seriesPods.isEmpty {
            DisclosureGroup(isExpanded: $pipelineExpanded) {
                SeriesPipelineView(
                    pods: seriesPods,
                    qualityScores: qualityScores,
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
                if loadError != nil {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundStyle(Color.orange)
                } else {
                    Image(systemName: "tray")
                        .font(.system(size: 32))
                        .foregroundStyle(.tertiary)
                }
                Text(loadError != nil ? "Failed to load pods" : "No pods")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let err = loadError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                    Button("Retry") {
                        Task { await onRefresh?() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                } else {
                    Text("Create a pod to get started")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if filteredSessions.isEmpty {
            VStack(spacing: 12) {
                ContentUnavailableView("No matching pods", systemImage: "line.3.horizontal.decrease", description: Text("Try another repository or search."))
                Button("Clear filters") { repositoryID = nil; searchText = "" }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch viewMode {
            case .cards:
                cardGrid
            case .list:
                sessionList
            }
        }
    }

    @ViewBuilder
    private var cardGrid: some View {
        if redesign { redesignedGrid } else { legacyCardGrid }
    }

    private var redesignedGrid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if sidebarSelection == .all || sidebarSelection == .active {
                    fleetGroup("Needs attention", pods: filteredSessions.filter { $0.status.needsAttention })
                    fleetGroup("In progress & recent", pods: filteredSessions.filter { !$0.status.needsAttention })
                } else { fleetGroup(nil, pods: filteredSessions) }
            }.padding(24)
            browseArchiveFooter(visibleCount: filteredSessions.count)
        }.background(DesktopTheme.canvas)
    }

    @ViewBuilder
    private func fleetGroup(_ title: String?, pods group: [Pod]) -> some View {
        if !group.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                if let title {
                    HStack(spacing: 8) {
                        Text(title).font(.caption.weight(.semibold))
                        Text("\(group.count)").font(.caption).foregroundStyle(.secondary)
                        DesktopTheme.line.frame(height: 1)
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 14)], spacing: 14) {
                    ForEach(group) { pod in
                        SessionCardFinal(pod: pod, actions: wiredActions, density: cardDensity,
                            isSelected: selectedSessionId == pod.id,
                            onSpawnFollowUp: { spawnFollowUpInitiator = $0 },
                            onLaunchSeriesFromPod: { seriesFromPod = $0 }, qualityScore: qualityScores[pod.id])
                            .onTapGesture { selectedSessionId = pod.id }
                    }
                }
            }
        }
    }

    private var legacyCardGrid: some View {
        let sessions = filteredSessions
        return ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 260), spacing: 10)],
                alignment: .leading,
                spacing: 10
            ) {
                ForEach(sessions) { pod in
                    SessionCardFinal(
                        pod: pod,
                        actions: wiredActions,
                        density: cardDensity,
                        isSelected: selectedSessionId == pod.id,
                        onSpawnFollowUp: { spawnFollowUpInitiator = $0 },
                        onLaunchSeriesFromPod: { seriesFromPod = $0 },
                        qualityScore: qualityScores[pod.id]
                    )
                    .onTapGesture { selectedSessionId = pod.id }
                }
            }
            .padding(16)
            browseArchiveFooter(visibleCount: sessions.count)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sessionList: some View {
        let sessions = filteredSessions
        return List(selection: $selectedSessionId) {
            ForEach(sessions) { pod in
                SessionListRow(pod: pod)
                    .tag(pod.id)
            }
            browseArchiveFooter(visibleCount: sessions.count)
        }
        .listStyle(.inset)
    }

    @ViewBuilder
    private func browseArchiveFooter(visibleCount: Int) -> some View {
        let queryIsEmpty = searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let total = repositoryID.map { id in pods.filter { repositoriesByPod[$0.id]?.id == id }.count } ?? pods.count
        if sidebarSelection == .all && browseScope == .recent && queryIsEmpty && visibleCount < total {
            HStack(spacing: 8) {
                Text("Showing \(visibleCount) of \(total)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Archive") {
                    browseScope = .archive
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
    }

    // MARK: - Analytics wiring helpers (static so unit tests can call them)

    /// Pure toggle: tapping the same card de-selects it; tapping a different card selects it.
    static func toggleAnalyticsCard(_ current: AnalyticsCardKind?, tapping: AnalyticsCardKind) -> AnalyticsCardKind? {
        current == tapping ? nil : tapping
    }

    /// Returns the state tuple produced by the `onSelectPod` handler in the detail pane.
    /// Extracted for unit testing without constructing the full view.
    static func analyticsSelectPodResult(sessionId: String) -> (card: AnalyticsCardKind?, sidebar: SidebarItem, session: String) {
        (card: nil, sidebar: .all, session: sessionId)
    }

    private func selectVillageActor(_ actor: VillageActor) {
        villageSelectedSource = actor.source
        if actor.source == .managed { selectedManagedPodId = actor.podId }
        else { selectedSessionId = actor.podId }
        villageShowsDetails = true
    }

    private func villageSnapshot(_ now: Date) -> VillageSnapshot {
        let actors = pods.map { VillageScene.native($0, events: eventsForPod?($0.id) ?? [], now: now) }
            + managedPods.map(VillageScene.managed)
        let query = villageSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        let visible = actors.filter { actor in
            !actor.isFinished && (query.isEmpty ||
                [actor.title, actor.profile, actor.model, actor.podId].contains {
                    $0.localizedCaseInsensitiveContains(query)
                })
        }.sorted { $0.id < $1.id }
        return VillageSnapshot(
            connected: isConnected, activityStreamConnected: activityStreamConnected,
            managedDataFresh: isConnected && managedPodsError == nil, reducedMotion: villageReducedMotion,
            selectedActorId: villageSelectedSource == .managed
                ? selectedManagedPodId.map { "managed:\($0)" }
                : selectedSessionId.map { "native:\($0)" }, actors: visible
        )
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

enum BrowseScope: String, CaseIterable {
    case recent = "Recent"
    case archive = "Archive"
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
                HStack(spacing: 6) {
                    Text(pod.id)
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                        .lineLimit(1)
                    if let name = pod.seriesName {
                        HStack(spacing: 3) {
                            Image(systemName: "rectangle.3.group.fill")
                                .font(.system(size: 9))
                            Text(name)
                                .font(.system(.caption2).weight(.medium))
                        }
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.accentColor.opacity(0.08))
                        .clipShape(Capsule())
                    }
                }
                Text(pod.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let diff = pod.diffStats {
                HStack(spacing: 3) {
                    Text(verbatim: "+\(diff.added)")
                        .foregroundStyle(.green)
                    Text(verbatim: "-\(diff.removed)")
                        .foregroundStyle(.red)
                }
                .font(.system(.caption2, design: .monospaced))
                .lineLimit(1)
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
