import AppKit
import AutopodClient
import SwiftUI

enum MemoryWorkbenchSelection: Hashable {
    case candidate(String)
    case memory(String)
}

/// Browse, approve, reject, and create memory entries.
public struct MemoryManagementView: View {
    public var entries: [MemoryEntry]
    public var activeMemories: [MemoryEntry]
    public var pendingCandidates: [MemoryCandidate]
    public var extractionAttempts: [MemoryExtractionAttempt]
    public var selectedUsage: [MemoryUsageEvent]
    public var selectedSourceEvidence: [MemorySourceEvidence]
    public var selectedStaleEvidence: [MemoryUsageEvent]
    public var selectedHarmfulEvidence: [MemoryUsageEvent]
    public var selectedMemoryDetailId: String?
    public var selectedCandidateDetailId: String?
    public var analytics: MemoryAnalyticsResponse?
    public var isLoadingDetails: Bool
    public var error: String?
    public var scopeFilter: MemoryScope?
    public var onApprove: (String) -> Void
    public var onReject: (String) -> Void
    public var onDelete: (String) -> Void
    public var onEdit: ((String, String) -> Void)?
    public var onApproveCandidate: (String) -> Void
    public var onRejectCandidate: (String) -> Void
    public var onEditCandidate: ((String, MemoryCandidateUpdate) -> Void)?
    public var onSelectMemory: ((String) -> Void)?
    public var onSelectCandidate: ((String) -> Void)?
    public var onCreateMemory: ((MemoryScope, String?, String, String) -> Void)?
    public var scopeNameLookup: ((MemoryScope, String) -> String?)?
    public var profileNames: [String]
    public var onScanMemories: ((String) -> Void)?
    public var configurationActions: LaunchConfigurationActions?

    @Environment(\.desktopRedesign) private var redesign
    @Environment(\.desktopWorkspaceDirty) private var workspaceDirty
    @Environment(\.desktopWorkspaceBusy) private var workspaceBusy
    public var workspaceActions: MemoryWorkspaceActions?
    public var isConnected: Bool
    public var isLoading: Bool
    public var refresh: (() async -> Void)?
    @State private var workspaceSection: String
    @State private var detailSection: String
    @State private var workspaceScope: MemoryScope?
    @State private var workspaceRepository: String?
    @State private var draft: DesktopMemoryDraft?
    @State private var originalDraft: DesktopMemoryDraft?
    @State private var draftBusy = false
    @State private var draftError: String?
    @State private var showDraftDiscard = false
    @State private var pendingMemoryNavigation: (() -> Void)?
    @State private var removalID: String?
    @State private var removeIsActive = false
    @State private var removeIsCandidate = false
    @State private var showMemoryRemoval = false
    @State private var selectedScope: MemoryScope = .global
    @State private var searchText = ""
    @State private var selectedItem: MemoryWorkbenchSelection?
    @State private var showingCreate = false
    @State private var editingEntry: MemoryEntry?
    @State private var editingCandidate: MemoryCandidate?
    @State private var viewingEntry: MemoryEntry?
    @State private var copiedId: String?

    public init(
        entries: [MemoryEntry],
        activeMemories: [MemoryEntry] = [],
        pendingCandidates: [MemoryCandidate] = [],
        extractionAttempts: [MemoryExtractionAttempt] = [],
        selectedUsage: [MemoryUsageEvent] = [],
        selectedSourceEvidence: [MemorySourceEvidence] = [],
        selectedStaleEvidence: [MemoryUsageEvent] = [],
        selectedHarmfulEvidence: [MemoryUsageEvent] = [],
        selectedMemoryDetailId: String? = nil,
        selectedCandidateDetailId: String? = nil,
        analytics: MemoryAnalyticsResponse? = nil,
        isLoadingDetails: Bool = false,
        error: String? = nil,
        scopeFilter: MemoryScope? = nil,
        onApprove: @escaping (String) -> Void = { _ in },
        onReject: @escaping (String) -> Void = { _ in },
        onDelete: @escaping (String) -> Void = { _ in },
        onEdit: ((String, String) -> Void)? = nil,
        onApproveCandidate: @escaping (String) -> Void = { _ in },
        onRejectCandidate: @escaping (String) -> Void = { _ in },
        onEditCandidate: ((String, MemoryCandidateUpdate) -> Void)? = nil,
        onSelectMemory: ((String) -> Void)? = nil,
        onSelectCandidate: ((String) -> Void)? = nil,
        onCreateMemory: ((MemoryScope, String?, String, String) -> Void)? = nil,
        scopeNameLookup: ((MemoryScope, String) -> String?)? = nil,
        profileNames: [String] = [],
        onScanMemories: ((String) -> Void)? = nil,
        configurationActions: LaunchConfigurationActions? = nil,
        workspaceActions: MemoryWorkspaceActions? = nil, isConnected: Bool = true, isLoading: Bool = false,
        refresh: (() async -> Void)? = nil, initialSection: String = "Review", initialDetail: String = "Content", initialMemoryID: String? = nil
    ) {
        _selectedItem = State(initialValue: initialMemoryID.map { .memory($0) })
        self.workspaceActions = workspaceActions; self.isConnected = isConnected; self.isLoading = isLoading; self.refresh = refresh
        _workspaceSection = State(initialValue: initialSection); _detailSection = State(initialValue: initialDetail)
        self.entries = entries
        self.activeMemories = activeMemories
        self.pendingCandidates = pendingCandidates
        self.extractionAttempts = extractionAttempts
        self.selectedUsage = selectedUsage
        self.selectedSourceEvidence = selectedSourceEvidence
        self.selectedStaleEvidence = selectedStaleEvidence
        self.selectedHarmfulEvidence = selectedHarmfulEvidence
        self.selectedMemoryDetailId = selectedMemoryDetailId
        self.selectedCandidateDetailId = selectedCandidateDetailId
        self.analytics = analytics
        self.isLoadingDetails = isLoadingDetails
        self.error = error
        self.scopeFilter = scopeFilter
        self.onApprove = onApprove
        self.onReject = onReject
        self.onDelete = onDelete
        self.onEdit = onEdit
        self.onApproveCandidate = onApproveCandidate
        self.onRejectCandidate = onRejectCandidate
        self.onEditCandidate = onEditCandidate
        self.onSelectMemory = onSelectMemory
        self.onSelectCandidate = onSelectCandidate
        self.onCreateMemory = onCreateMemory
        self.scopeNameLookup = scopeNameLookup
        self.profileNames = profileNames
        self.onScanMemories = onScanMemories
        self.configurationActions = configurationActions
    }

    private var displayedScope: MemoryScope {
        scopeFilter ?? selectedScope
    }

    private var filteredEntries: [MemoryEntry] {
        desktopMode ? entries.filter(matchesWorkspace) : Self.filteredEntries(entries, scope: displayedScope, query: searchText)
    }

    private var pending: [MemoryEntry] { filteredEntries.filter { !$0.approved } }
    private var approved: [MemoryEntry] {
        if desktopMode { return Self.mergeEntries(entries.filter(\.approved), with: activeMemories).filter(matchesWorkspace) }
        return Self.approvedEntries(
            entries: entries,
            activeMemories: activeMemories,
            scope: displayedScope,
            query: searchText
        )
    }

    private var candidates: [MemoryCandidate] {
        if desktopMode {
            return pendingCandidates.filter { matchesWorkspace(scope: $0.scope, scopeID: $0.scopeId, path: $0.path, content: $0.content, origin: $0.createdByPodId, extra: ($0.rationale ?? "") + $0.tags.joined(separator: " ") + $0.impactSummary) }
        }
        return Self.filteredCandidates(pendingCandidates, scope: displayedScope, query: searchText)
    }

    private var visibleExtractionAttempts: [MemoryExtractionAttempt] {
        Self.filteredExtractionAttempts(extractionAttempts, scope: desktopMode ? .global : displayedScope, query: searchText)
    }

    private var selectedMemory: MemoryEntry? {
        guard case .memory(let id) = selectedItem else { return nil }
        return (desktopMode ? workspaceMemories : approved).first { $0.id == id }
    }

    private var selectedCandidate: MemoryCandidate? {
        guard case .candidate(let id) = selectedItem else { return nil }
        return candidates.first { $0.id == id }
    }

    public var body: some View {
        Group { if desktopMode { desktopBody } else { legacyBody } }
    }
    private var legacyBody: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            HSplitView {
                leftPane
                    .frame(minWidth: 320, idealWidth: 380)
                detailPane
                    .frame(minWidth: 420, maxWidth: .infinity)
            }
        }
        .onAppear { ensureSelection() }
        .onChange(of: entries.map(\.id)) { _, _ in ensureSelection() }
        .onChange(of: pendingCandidates.map(\.id)) { _, _ in ensureSelection() }
        .onChange(of: selectedScope) { _, _ in ensureSelection() }
        .onChange(of: searchText) { _, _ in ensureSelection() }
        .onChange(of: selectedItem) { _, newValue in
            switch newValue {
            case .memory(let id):
                onSelectMemory?(id)
            case .candidate(let id):
                onSelectCandidate?(id)
            case .none:
                break
            }
        }
        .sheet(isPresented: $showingCreate) {
            CreateMemorySheet(
                defaultScope: scopeFilter ?? selectedScope,
                scopeLocked: scopeFilter != nil,
                onCreate: { scope, scopeId, path, content in
                    onCreateMemory?(scope, scopeId, path, content)
                    showingCreate = false
                },
                onCancel: { showingCreate = false }
            )
        }
        .sheet(item: $editingEntry) { entry in
            EditMemorySheet(
                entry: entry,
                onSave: { id, content in
                    onEdit?(id, content)
                    editingEntry = nil
                },
                onCancel: { editingEntry = nil }
            )
        }
        .sheet(item: $editingCandidate) { candidate in
            EditMemoryCandidateSheet(
                candidate: candidate,
                onSave: { id, update in
                    onEditCandidate?(id, update)
                    editingCandidate = nil
                },
                onCancel: { editingCandidate = nil }
            )
        }
        .sheet(item: $viewingEntry) { entry in
            ViewMemorySheet(
                entry: entry,
                onApprove: !entry.approved ? { id in
                    onApprove(id)
                    viewingEntry = nil
                } : nil,
                onReject: !entry.approved ? { id in
                    onReject(id)
                    viewingEntry = nil
                } : nil,
                onEdit: (entry.approved && onEdit != nil) ? {
                    editingEntry = entry
                    viewingEntry = nil
                } : nil,
                onDelete: entry.approved ? { id in
                    onDelete(id)
                    viewingEntry = nil
                } : nil,
                onClose: { viewingEntry = nil }
            )
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            if scopeFilter == nil {
                scopePicker
            }
            searchField
            if onCreateMemory != nil {
                Button {
                    showingCreate = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("New memory")
            }
        }
        .padding(.trailing, 12)
    }

    private var searchField: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            TextField("Search memories", text: $searchText)
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
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .frame(width: 220)
    }

    private var leftPane: some View {
        VStack(spacing: 0) {
            if let error {
                inlineError(error)
                    .padding([.horizontal, .top], 12)
            }
            if candidates.isEmpty && pending.isEmpty && approved.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !candidates.isEmpty {
                            candidateSection
                        }
                        if !pending.isEmpty {
                            pendingSection
                        }
                        if !approved.isEmpty {
                            approvedSection
                        }
                        if configurationActions != nil && scopeFilter == nil {
                            scanSection
                        }
                    }
                    .padding(16)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Scope picker

    private var scopePicker: some View {
        HStack(spacing: 0) {
            ForEach(MemoryScope.allCases, id: \.self) { s in
                Button {
                    selectedScope = s
                } label: {
                    Text(s.label)
                        .font(.caption)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(selectedScope == s ? Color.accentColor.opacity(0.15) : Color.clear)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(selectedScope == s ? .primary : .secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: - Origin grouping

    private func groupedByOrigin(_ entries: [MemoryEntry]) -> [(key: String, entries: [MemoryEntry])] {
        let grouped = Dictionary(grouping: entries) { Self.originKey(for: $0) }
        return grouped
            .map { (key: $0.key, entries: $0.value) }
            .sorted { a, b in
                let aLatest = a.entries.map(\.updatedAt).max() ?? ""
                let bLatest = b.entries.map(\.updatedAt).max() ?? ""
                return aLatest > bLatest
            }
    }

    private func originHeader(_ label: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
            Text(label)
                .font(.system(.caption2, design: .monospaced).weight(.medium))
                .foregroundStyle(.secondary)
            Text("\(count)")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(.quaternary, in: Capsule())
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }

    // MARK: - Pending suggestions

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "clock.badge.questionmark")
                    .foregroundStyle(.orange)
                Text("Pending Approval")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(pending.count)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.orange.opacity(0.1), in: Capsule())
            }
            ForEach(groupedByOrigin(pending), id: \.key) { group in
                originHeader(group.key, count: group.entries.count)
                ForEach(group.entries) { entry in
                    memoryCard(entry, isPending: true)
                }
            }
        }
    }

    private var candidateSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lightbulb")
                    .foregroundStyle(.orange)
                Text("Pending Candidates")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(candidates.count)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.orange.opacity(0.1), in: Capsule())
            }
            ForEach(Self.groupCandidatesByOrigin(candidates), id: \.key) { group in
                originHeader(group.key, count: group.candidates.count)
                ForEach(group.candidates) { candidate in
                    candidateCard(candidate)
                }
            }
        }
    }

    // MARK: - Approved entries

    private var approvedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text("Active Memories")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(approved.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
            ForEach(groupedByOrigin(approved), id: \.key) { group in
                originHeader(group.key, count: group.entries.count)
                ForEach(group.entries) { entry in
                    memoryCard(entry, isPending: false)
                }
            }
        }
    }

    // MARK: - Detail pane

    private var detailPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if isLoadingDetails {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if let candidate = selectedCandidate {
                    candidateDetail(candidate)
                } else if let memory = selectedMemory {
                    memoryDetail(memory)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "sidebar.right")
                            .font(.system(size: 36, weight: .thin))
                            .foregroundStyle(.tertiary)
                        Text("Select a memory or candidate")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 260)
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func candidateDetail(_ candidate: MemoryCandidate) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            detailHeader(
                title: candidate.path,
                subtitle: [
                    Self.scopeLabel(scope: candidate.scope, scopeId: candidate.scopeId, repositorySetupId: candidate.repositorySetupId),
                    candidate.createdByPodId.map { "source pod \(Self.shortId($0))" },
                    "\(candidate.action.rawValue) candidate",
                    candidate.kind.rawValue,
                ].compactMap(\.self).joined(separator: " · "),
                confidence: candidate.confidence,
                tags: candidate.tags
            )
            if let rationale = candidate.rationale, !rationale.isEmpty {
                infoPanel(title: "Rationale", text: rationale, systemImage: "quote.bubble")
            }
            infoPanel(title: "Impact", text: candidate.impactSummary, systemImage: "chart.line.uptrend.xyaxis")
            contentPanel(candidate.content)
            evidencePanel(
                title: "Source Evidence",
                evidence: detailSourceEvidence(for: .candidate(candidate.id), fallback: candidate.sourceEvidence)
            )
            HStack(spacing: 8) {
                Button {
                    onApproveCandidate(candidate.id)
                } label: {
                    Label("Approve", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                Button {
                    editingCandidate = candidate
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .buttonStyle(.bordered)
                .disabled(onEditCandidate == nil)
                Button(role: .destructive) {
                    onRejectCandidate(candidate.id)
                } label: {
                    Label("Reject", systemImage: "xmark")
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
    }

    private func memoryDetail(_ memory: MemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            let sourcePodId = Self.sourcePodId(for: memory)
            detailHeader(
                title: memory.path,
                subtitle: [
                    Self.scopeLabel(scope: memory.scope, scopeId: memory.scopeId, repositorySetupId: memory.repositorySetupId),
                    sourcePodId.map { "source pod \(Self.shortId($0))" },
                    "active memory",
                    "v\(memory.version)",
                ].compactMap(\.self).joined(separator: " · "),
                confidence: memory.confidence,
                tags: memory.tags
            )
            if let rationale = memory.rationale, !rationale.isEmpty {
                infoPanel(title: "Rationale", text: rationale, systemImage: "quote.bubble")
            }
            contentPanel(memory.content)
            let staleEvidence = detailStaleEvidence(for: memory.id)
            let harmfulEvidence = detailHarmfulEvidence(for: memory.id)
            if Self.hasWarningEvidence(stale: staleEvidence, harmful: harmfulEvidence) {
                warningPanel(stale: staleEvidence, harmful: harmfulEvidence)
            }
            evidencePanel(
                title: "Source Evidence",
                evidence: detailSourceEvidence(for: .memory(memory.id), fallback: memory.sourceEvidence)
            )
            let usage = detailUsage(for: memory.id)
            impactPanel(memory, usage: usage)
            usagePanel(usage)
            HStack(spacing: 8) {
                if onEdit != nil {
                    Button {
                        editingEntry = memory
                    } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    .buttonStyle(.bordered)
                }
                Button(role: .destructive) {
                    onDelete(memory.id)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
    }

    // MARK: - Scan & Fix section

    private func detailSourceEvidence(
        for selection: MemoryWorkbenchSelection,
        fallback: [MemorySourceEvidence]
    ) -> [MemorySourceEvidence] {
        guard Self.detailPayloadMatches(
            selection: selection,
            selectedMemoryDetailId: selectedMemoryDetailId,
            selectedCandidateDetailId: selectedCandidateDetailId
        ) else {
            return fallback
        }
        return selectedSourceEvidence.isEmpty ? fallback : selectedSourceEvidence
    }

    private func detailUsage(for memoryId: String) -> [MemoryUsageEvent] {
        guard selectedMemoryDetailId == memoryId, selectedCandidateDetailId == nil else { return [] }
        return Self.usageForMemory(selectedUsage, memoryId: memoryId)
    }

    private func detailStaleEvidence(for memoryId: String) -> [MemoryUsageEvent] {
        guard selectedMemoryDetailId == memoryId, selectedCandidateDetailId == nil else { return [] }
        return Self.usageForMemory(selectedStaleEvidence, memoryId: memoryId)
    }

    private func detailHarmfulEvidence(for memoryId: String) -> [MemoryUsageEvent] {
        guard selectedMemoryDetailId == memoryId, selectedCandidateDetailId == nil else { return [] }
        return Self.usageForMemory(selectedHarmfulEvidence, memoryId: memoryId)
    }

    private var scanSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Analyze & Fix").font(.subheadline.weight(.semibold))
            Text("Review project memories and draft a fix plan in an interactive workspace.")
                .foregroundStyle(.secondary)
            AnalysisWorkspaceLauncher(kind: "memory", actions: configurationActions)
        }
    }

    private func candidateCard(_ candidate: MemoryCandidate) -> some View {
        Button { selectedItem = .candidate(candidate.id) } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: candidate.action == .update ? "arrow.triangle.2.circlepath" : "plus.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(.orange)
                    Text(candidate.path)
                        .font(.system(.caption, design: .monospaced).weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    Text("\(Int((candidate.confidence * 100).rounded()))")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                    Text(candidate.kind.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let podId = candidate.createdByPodId {
                    provenanceRow(
                        primary: Self.scopeLabel(scope: candidate.scope, scopeId: candidate.scopeId, repositorySetupId: candidate.repositorySetupId),
                        secondary: "source pod \(Self.shortId(podId))"
                    )
                } else {
                    provenanceRow(
                        primary: Self.scopeLabel(scope: candidate.scope, scopeId: candidate.scopeId, repositorySetupId: candidate.repositorySetupId),
                        secondary: nil
                    )
                }
                Text(candidate.impactSummary.isEmpty ? candidate.content : candidate.impactSummary)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    Button {
                        onApproveCandidate(candidate.id)
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .font(.caption)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .tint(.green)

                    Button {
                        editingCandidate = candidate
                    } label: {
                        Label("Edit", systemImage: "pencil")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(onEditCandidate == nil)

                    Button {
                        onRejectCandidate(candidate.id)
                    } label: {
                        Label("Reject", systemImage: "xmark")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .tint(.red)
                }
            }
            .padding(12)
            .background(cardBackground(isSelected: selectedItem == .candidate(candidate.id)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.orange.opacity(selectedItem == .candidate(candidate.id) ? 0.7 : 0.2), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Memory card

    private func memoryCard(_ entry: MemoryEntry, isPending: Bool) -> some View {
        Button {
            if isPending {
                viewingEntry = entry
            } else {
                selectedItem = .memory(entry.id)
            }
        } label: {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text(entry.path)
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                if let scopeLabel = resolvedScopeLabel(for: entry) {
                    Text("· \(scopeLabel)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer()
                Button {
                    copyId(entry.id)
                } label: {
                    Text(copiedId == entry.id ? "copied" : shortId(entry.id))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Click to copy full id: \(entry.id)")
                Text("v\(entry.version)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let podId = Self.sourcePodId(for: entry) {
                    Text("source pod \(Self.shortId(podId))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            provenanceRow(
                primary: resolvedScopeLabel(for: entry) ?? Self.scopeLabel(
                    scope: entry.scope,
                    scopeId: entry.scopeId
                ),
                secondary: Self.sourcePodId(for: entry).map { "source pod \(Self.shortId($0))" }
            )

            if let rationale = entry.rationale, !rationale.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Text("Why:")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(rationale)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            Text(entry.content)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isPending {
                HStack(spacing: 8) {
                    Button {
                        onApprove(entry.id)
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .font(.caption)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .tint(.green)

                    Button {
                        onReject(entry.id)
                    } label: {
                        Label("Reject", systemImage: "xmark")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .tint(.red)
                }
            } else {
                HStack {
                    Spacer()
                    if onEdit != nil {
                        Button {
                            editingEntry = entry
                        } label: {
                            Image(systemName: "pencil")
                                .font(.system(size: 10))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.tertiary)
                    }
                    Button(role: .destructive) {
                        onDelete(entry.id)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .background(cardBackground(isSelected: selectedItem == .memory(entry.id)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(
                    isPending ? Color.orange.opacity(0.2)
                        : Color.accentColor.opacity(selectedItem == .memory(entry.id) ? 0.7 : 0),
                    lineWidth: 1
                )
        )
        } // end label
        .buttonStyle(.plain)
    }

    private func cardBackground(isSelected: Bool) -> Color {
        isSelected ? Color.accentColor.opacity(0.08) : (desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor))
    }

    private func provenanceRow(primary: String, secondary: String?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "person.text.rectangle")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
            Text(primary)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            if let secondary {
                Text("· \(secondary)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .lineLimit(1)
    }

    private func resolvedScopeLabel(for entry: MemoryEntry) -> String? {
        guard let scopeId = entry.scopeId, entry.scope != .global else {
            return entry.scope == .global ? Self.scopeLabel(scope: entry.scope, scopeId: nil) : nil
        }
        let displayName = scopeNameLookup?(entry.scope, scopeId)
        switch entry.scope {
        case .repository, .profile:
            return Self.scopeLabel(scope: entry.scope, scopeId: displayName ?? scopeId, repositorySetupId: entry.repositorySetupId)
        case .pod:
            return "pod \(displayName ?? Self.shortId(scopeId))"
        case .unknown(let value):
            return "\(value) \(displayName ?? scopeId)"
        case .global:
            return "global"
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "brain")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("No memories")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if visibleExtractionAttempts.isEmpty {
                Text("Agents can suggest memories for review, or you can create one manually.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(visibleExtractionAttempts.prefix(4)) { attempt in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: attemptIcon(attempt.status))
                                .font(.caption)
                                .foregroundStyle(attemptColor(attempt.status))
                                .frame(width: 14)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(attempt.profileName) · \(attempt.status.label)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Text(Self.humanReadableAttemptReason(attempt.reason))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
                .frame(maxWidth: 360)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }

    private func attemptIcon(_ status: MemoryExtractionAttemptStatus) -> String {
        switch status {
        case .candidateCreated: "checkmark.circle"
        case .belowThreshold, .noCandidate, .skipped: "minus.circle"
        case .reviewerUnavailable, .reviewerFailed, .invalidResponse: "exclamationmark.triangle"
        case .unknown: "questionmark.circle"
        }
    }

    private func attemptColor(_ status: MemoryExtractionAttemptStatus) -> Color {
        switch status {
        case .candidateCreated: .green
        case .belowThreshold, .noCandidate, .skipped: .secondary
        case .reviewerUnavailable, .reviewerFailed, .invalidResponse: .orange
        case .unknown: .secondary
        }
    }

    private func detailHeader(
        title: String,
        subtitle: String,
        confidence: Double?,
        tags: [String]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.title3, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let confidence {
                    Text("confidence \(Int((confidence * 100).rounded()))")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }
            if !tags.isEmpty {
                FlowTags(tags: tags)
            }
        }
    }

    private func contentPanel(_ content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Content")
                .font(.headline)
            Text(content)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func infoPanel(title: String, text: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.headline)
            Text(text.isEmpty ? "No details recorded." : text)
                .font(.caption)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func evidencePanel(title: String, evidence: [MemorySourceEvidence]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "text.quote")
                .font(.headline)
            if evidence.isEmpty {
                Text("No source evidence recorded.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(evidence.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(item.signal)
                                .font(.caption.weight(.medium))
                            if let podId = item.podId {
                                Text("pod \(shortId(podId))")
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            if let severity = item.severity {
                                Text(severity.rawValue)
                                    .font(.caption2)
                                    .foregroundStyle(severity == .high ? Color.red : Color.secondary)
                            }
                        }
                        Text(item.excerpt)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func warningPanel(stale: [MemoryUsageEvent], harmful: [MemoryUsageEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Stale or harmful evidence", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            ForEach((harmful + stale).prefix(6)) { event in
                usageRow(event)
            }
            Text("Review the evidence, then edit or delete the memory manually.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.25), lineWidth: 1))
    }

    private func impactPanel(_ memory: MemoryEntry, usage: [MemoryUsageEvent]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Impact", systemImage: "chart.bar")
                .font(.headline)
            let counts = Self.usageImpactCounts(usage)
            HStack(spacing: 12) {
                impactMetric("selected", counts.selected)
                impactMetric("injected", counts.injected)
                impactMetric("read", counts.read)
                impactMetric("applied", counts.applied)
            }
            if let summary = memory.impactSummary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let top = analytics?.topMemories.first(where: { $0.memoryId == memory.id }) {
                Text("Fleet window: selected \(top.selectedCount), injected \(top.injectedCount), applied \(top.appliedCount), harmful/stale \(top.harmfulStaleCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func usagePanel(_ usage: [MemoryUsageEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Recent Usage", systemImage: "clock.arrow.circlepath")
                .font(.headline)
            if usage.isEmpty {
                Text("No usage recorded.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(usage.prefix(10)) { event in
                    usageRow(event)
                    if event.id != usage.prefix(10).last?.id {
                        Divider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background((desktopMode ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func usageRow(_ event: MemoryUsageEvent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(event.kind.rawValue)
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                if let outcome = event.outcome {
                    Text(outcome.rawValue)
                        .font(.caption2)
                        .foregroundStyle(outcome == .harmfulStale ? Color.red : Color.secondary)
                }
                Spacer()
                Text(shortId(event.podId))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            if let reason = event.reason ?? event.relevanceReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func impactMetric(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.system(.title3, design: .monospaced).weight(.semibold))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 64, alignment: .leading)
    }

    private func inlineError(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func ensureSelection() {
        if desktopMode {
            guard workspaceSection != "Extraction", draft == nil else { return }
            selectedItem = Self.preferredSelection(current: selectedItem, candidates: workspaceSection == "Review" ? candidates : [], memories: workspaceMemories)
            return
        }
        if let selectedItem {
            let preferred = Self.preferredSelection(
                current: selectedItem,
                candidates: candidates,
                memories: approved
            )
            if preferred == selectedItem { return }
        }
        selectedItem = Self.preferredSelection(current: selectedItem, candidates: candidates, memories: approved)
    }

    static func filteredEntries(
        _ entries: [MemoryEntry],
        scope: MemoryScope,
        query: String
    ) -> [MemoryEntry] {
        let scoped = entries.filter { $0.scope == scope }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return scoped }
        return scoped.filter {
            $0.path.localizedCaseInsensitiveContains(q)
                || $0.content.localizedCaseInsensitiveContains(q)
                || ($0.rationale?.localizedCaseInsensitiveContains(q) ?? false)
                || $0.tags.contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }

    static func approvedEntries(
        entries: [MemoryEntry],
        activeMemories: [MemoryEntry],
        scope: MemoryScope,
        query: String
    ) -> [MemoryEntry] {
        let approvedEntries = entries.filter(\.approved)
        let source = mergeEntries(approvedEntries, with: activeMemories)
        return filteredEntries(source, scope: scope, query: query)
    }

    private static func mergeEntries(
        _ existing: [MemoryEntry],
        with incoming: [MemoryEntry]
    ) -> [MemoryEntry] {
        var merged = existing
        for entry in incoming {
            if let idx = merged.firstIndex(where: { $0.id == entry.id }) {
                merged[idx] = entry
            } else {
                merged.append(entry)
            }
        }
        return merged
    }

    static func filteredCandidates(
        _ candidates: [MemoryCandidate],
        scope: MemoryScope,
        query: String
    ) -> [MemoryCandidate] {
        let scoped = candidates.filter { $0.scope == scope }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return scoped }
        return scoped.filter {
            $0.path.localizedCaseInsensitiveContains(q)
                || $0.content.localizedCaseInsensitiveContains(q)
                || ($0.rationale?.localizedCaseInsensitiveContains(q) ?? false)
                || $0.impactSummary.localizedCaseInsensitiveContains(q)
                || $0.tags.contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }

    static func filteredExtractionAttempts(
        _ attempts: [MemoryExtractionAttempt],
        scope: MemoryScope,
        query: String
    ) -> [MemoryExtractionAttempt] {
        guard scope != .pod else { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return attempts }
        return attempts.filter {
            $0.profileName.localizedCaseInsensitiveContains(q)
                || $0.podId.localizedCaseInsensitiveContains(q)
                || $0.status.label.localizedCaseInsensitiveContains(q)
                || $0.reason.localizedCaseInsensitiveContains(q)
                || $0.signals.contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }

    static func humanReadableAttemptReason(_ reason: String) -> String {
        switch reason {
        case "lesson_potential_below_threshold":
            return "Signals were too weak for a durable candidate."
        case "openai_auth_unavailable":
            return "OpenAI reviewer credentials were unavailable."
        case "no_anthropic_api_key":
            return "Anthropic reviewer credentials were unavailable."
        case "provider_not_callable":
            return "The profile provider could not run daemon-side review."
        case "reviewer_decided_no_lesson":
            return "The reviewer found no durable lesson."
        case "candidate_created":
            return "A pending candidate was created for review."
        case "agent_mode_not_auto":
            return "Interactive pods are not auto-extracted."
        case "profile_not_found":
            return "The pod profile could not be loaded."
        default:
            return reason.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func groupCandidatesByOrigin(
        _ candidates: [MemoryCandidate]
    ) -> [(key: String, candidates: [MemoryCandidate])] {
        let grouped = Dictionary(grouping: candidates) { $0.createdByPodId ?? "Manual" }
        return grouped
            .map { (key: $0.key, candidates: $0.value) }
            .sorted { a, b in
                let aLatest = a.candidates.map(\.updatedAt).max() ?? ""
                let bLatest = b.candidates.map(\.updatedAt).max() ?? ""
                return aLatest > bLatest
            }
    }

    static func originKey(for entry: MemoryEntry) -> String {
        entry.createdByPodId ?? entry.createdBySessionId ?? "Manual"
    }

    static func sourcePodId(for entry: MemoryEntry) -> String? {
        let value = originKey(for: entry)
        return value == "Manual" ? nil : value
    }

    static func scopeLabel(scope: MemoryScope, scopeId: String?, repositorySetupId: String? = nil) -> String {
        switch scope {
        case .global:
            return "global"
        case .repository, .profile:
            guard let scopeId, !scopeId.isEmpty else { return "\(scope.label.lowercased()) unknown" }
            return "\(scope.label.lowercased()) \(scopeId)" + (repositorySetupId.map { " · setup \($0)" } ?? "")
        case .pod:
            guard let scopeId, !scopeId.isEmpty else { return "pod unknown" }
            return "pod \(shortId(scopeId))"
        case .unknown(let value):
            guard let scopeId, !scopeId.isEmpty else { return value }
            return "\(value) \(scopeId)"
        }
    }

    static func usageImpactCounts(
        _ usage: [MemoryUsageEvent]
    ) -> (selected: Int, injected: Int, read: Int, applied: Int) {
        (
            selected: usage.filter { $0.kind == .selected }.count,
            injected: usage.filter { $0.kind == .injected }.count,
            read: usage.filter { $0.kind == .read }.count,
            applied: usage.filter { $0.outcome == .applied }.count
        )
    }

    static func detailPayloadMatches(
        selection: MemoryWorkbenchSelection,
        selectedMemoryDetailId: String?,
        selectedCandidateDetailId: String?
    ) -> Bool {
        switch selection {
        case .memory(let id):
            return selectedMemoryDetailId == id && selectedCandidateDetailId == nil
        case .candidate(let id):
            return selectedCandidateDetailId == id && selectedMemoryDetailId == nil
        }
    }

    static func usageForMemory(
        _ usage: [MemoryUsageEvent],
        memoryId: String
    ) -> [MemoryUsageEvent] {
        usage.filter { $0.memoryId == memoryId }
    }

    static func hasWarningEvidence(stale: [MemoryUsageEvent], harmful: [MemoryUsageEvent]) -> Bool {
        !stale.isEmpty || !harmful.isEmpty
    }

    static func preferredSelection(
        current: MemoryWorkbenchSelection?,
        candidates: [MemoryCandidate],
        memories: [MemoryEntry]
    ) -> MemoryWorkbenchSelection? {
        if let current {
            switch current {
            case .candidate(let id) where candidates.contains(where: { $0.id == id }):
                return current
            case .memory(let id) where memories.contains(where: { $0.id == id }):
                return current
            default:
                break
            }
        }
        if let first = candidates.first { return .candidate(first.id) }
        if let first = memories.first { return .memory(first.id) }
        return nil
    }

    static func shortId(_ id: String) -> String {
        id.count > 8 ? String(id.prefix(8)) : id
    }

    private func shortId(_ id: String) -> String {
        Self.shortId(id)
    }

    private func copyId(_ id: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(id, forType: .string)
        withAnimation(.easeOut(duration: 0.15)) { copiedId = id }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation(.easeOut(duration: 0.3)) {
                if copiedId == id { copiedId = nil }
            }
        }
    }
}

// MARK: - Create memory sheet

struct CreateMemorySheet: View {
    let defaultScope: MemoryScope
    let scopeLocked: Bool
    let onCreate: (MemoryScope, String?, String, String) -> Void
    let onCancel: () -> Void

    @State private var scope: MemoryScope
    @State private var scopeId: String = ""
    @State private var path: String = ""
    @State private var content: String = ""

    init(
        defaultScope: MemoryScope,
        scopeLocked: Bool,
        onCreate: @escaping (MemoryScope, String?, String, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.defaultScope = defaultScope
        self.scopeLocked = scopeLocked
        self.onCreate = onCreate
        self.onCancel = onCancel
        self._scope = State(initialValue: defaultScope)
    }

    private var isValid: Bool { !path.trimmingCharacters(in: .whitespaces).isEmpty && !content.trimmingCharacters(in: .whitespaces).isEmpty }
    private var resolvedScopeId: String? { scope == .global ? nil : scopeId.isEmpty ? nil : scopeId }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "brain")
                    .foregroundStyle(.purple)
                Text("New Memory")
                    .font(.headline)
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    onCreate(scope, resolvedScopeId, path.trimmingCharacters(in: .whitespaces), content)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Scope
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Scope")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        if scopeLocked {
                            Text(scope.label)
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        } else {
                            Picker("", selection: $scope) {
                                ForEach(MemoryScope.allCases, id: \.self) { s in
                                    Text(s.label).tag(s)
                                }
                            }
                            .pickerStyle(.segmented)
                        }
                    }

                    // Scope ID (hidden for global)
                    if scope != .global {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(scope == .repository ? "Repository ID" : scope == .profile ? "Legacy profile name" : "Pod ID")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField((scope == .profile || scope == .repository) ? "my-app" : "abc12345", text: $scopeId)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                        }
                    }

                    // Path
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Path")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextField("/conventions/commits.md", text: $path)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        Text("Use a path-like key to organize memories, e.g. /conventions/commits.md")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }

                    // Content
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Content")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: $content)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 120)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                            )
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 480)
    }
}

private struct FlowTags: View {
    let tags: [String]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(tags.prefix(8), id: \.self) { tag in
                Text(tag)
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.08), in: Capsule())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct EditMemoryCandidateSheet: View {
    let candidate: MemoryCandidate
    let onSave: (String, MemoryCandidateUpdate) -> Void
    let onCancel: () -> Void

    @State private var path: String
    @State private var content: String
    @State private var rationale: String
    @State private var appliesWhen: String
    @State private var avoidWhen: String
    @State private var impactSummary: String

    init(
        candidate: MemoryCandidate,
        onSave: @escaping (String, MemoryCandidateUpdate) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.candidate = candidate
        self.onSave = onSave
        self.onCancel = onCancel
        self._path = State(initialValue: candidate.path)
        self._content = State(initialValue: candidate.content)
        self._rationale = State(initialValue: candidate.rationale ?? "")
        self._appliesWhen = State(initialValue: candidate.appliesWhen ?? "")
        self._avoidWhen = State(initialValue: candidate.avoidWhen ?? "")
        self._impactSummary = State(initialValue: candidate.impactSummary)
    }

    private var isValid: Bool {
        !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "lightbulb")
                    .foregroundStyle(.orange)
                Text("Edit Candidate")
                    .font(.headline)
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    onSave(
                        candidate.id,
                        MemoryCandidateUpdate(
                            path: trimmed(path),
                            content: content,
                            rationale: optionalTrimmed(rationale),
                            kind: candidate.kind,
                            tags: candidate.tags,
                            appliesWhen: optionalTrimmed(appliesWhen),
                            avoidWhen: optionalTrimmed(avoidWhen),
                            confidence: candidate.confidence,
                            sourceEvidence: candidate.sourceEvidence,
                            impactSummary: trimmed(impactSummary)
                        )
                    )
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    labeledField("Path", text: $path)
                    labeledEditor("Content", text: $content, minHeight: 140)
                    labeledEditor("Rationale", text: $rationale, minHeight: 70)
                    labeledEditor("Applies When", text: $appliesWhen, minHeight: 60)
                    labeledEditor("Avoid When", text: $avoidWhen, minHeight: 60)
                    labeledEditor("Impact", text: $impactSummary, minHeight: 70)
                }
                .padding(16)
            }
        }
        .frame(width: 560, height: 620)
    }

    private func labeledField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField(title, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
        }
    }

    private func labeledEditor(_ title: String, text: Binding<String>, minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextEditor(text: text)
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: minHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
        }
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func optionalTrimmed(_ value: String) -> String? {
        let result = trimmed(value)
        return result.isEmpty ? nil : result
    }
}

// MARK: - View memory sheet (read-only)

struct ViewMemorySheet: View {
    let entry: MemoryEntry
    let onApprove: ((String) -> Void)?
    let onReject: ((String) -> Void)?
    let onEdit: (() -> Void)?
    let onDelete: ((String) -> Void)?
    let onClose: () -> Void

    private var isPending: Bool { !entry.approved }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "doc.text")
                    .foregroundStyle(isPending ? .orange : .purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text(isPending ? "Pending Memory" : "Memory")
                        .font(.headline)
                    Text(entry.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("v\(entry.version)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let sid = entry.createdBySessionId {
                    Text("by \(sid)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Button("Close", action: onClose)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
            .padding(16)

            Divider()

            if let rationale = entry.rationale, !rationale.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Why it matters")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(rationale)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                Divider()
            }

            ScrollView {
                Text(entry.content)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(16)
            }

            if isPending || onEdit != nil || onDelete != nil {
                Divider()
                HStack(spacing: 8) {
                    if isPending {
                        if let approve = onApprove {
                            Button { approve(entry.id) } label: {
                                Label("Approve", systemImage: "checkmark")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.mini)
                            .tint(.green)
                        }
                        if let reject = onReject {
                            Button { reject(entry.id) } label: {
                                Label("Reject", systemImage: "xmark")
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                            .tint(.red)
                        }
                    } else {
                        Spacer()
                        if let edit = onEdit {
                            Button { edit() } label: {
                                Label("Edit", systemImage: "pencil")
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                        if let delete = onDelete {
                            Button(role: .destructive) { delete(entry.id) } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 11))
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                    }
                }
                .padding(12)
            }
        }
        .frame(minWidth: 520, maxWidth: 520, minHeight: 320)
    }
}

// MARK: - Edit memory sheet

struct EditMemorySheet: View {
    let entry: MemoryEntry
    let onSave: (String, String) -> Void
    let onCancel: () -> Void

    @State private var content: String

    init(entry: MemoryEntry, onSave: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.entry = entry
        self.onSave = onSave
        self.onCancel = onCancel
        self._content = State(initialValue: entry.content)
    }

    private var hasChanges: Bool { content != entry.content }
    private var isValid: Bool { !content.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "pencil")
                    .foregroundStyle(.purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Edit Memory")
                        .font(.headline)
                    Text(entry.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    onSave(entry.id, content)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid || !hasChanges)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Content")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: $content)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 200)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                            )
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 480)
    }
}

// MARK: - Desktop knowledge workspace
extension MemoryManagementView {
    private var desktopMode: Bool { redesign && scopeFilter == nil }
    private var workspaceMemories: [MemoryEntry] {
        workspaceSection == "Review" ? pending : approved
    }
    private var repositoryIDs: [String] {
        Array(Set((entries + activeMemories).filter { $0.scope == .repository }.compactMap(\.scopeId)
            + pendingCandidates.filter { $0.scope == .repository }.compactMap(\.scopeId))).sorted()
    }
    private func matchesWorkspace(scope: MemoryScope, scopeID: String?, path: String, content: String, origin: String?, extra: String) -> Bool {
        if let workspaceScope, scope != workspaceScope { return false }
        if let workspaceRepository, scope != .repository || scopeID != workspaceRepository { return false }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || [path, content, origin ?? "", scopeID ?? "", extra].joined(separator: " ").localizedCaseInsensitiveContains(query)
    }
    private func matchesWorkspace(_ entry: MemoryEntry) -> Bool {
        matchesWorkspace(scope: entry.scope, scopeID: entry.scopeId, path: entry.path, content: entry.content,
            origin: Self.originKey(for: entry), extra: (entry.rationale ?? "") + entry.tags.joined(separator: " "))
    }
    private var desktopContent: some View {
        VStack(spacing: 0) {
            DesktopInsightsHeader(title: "Memory", subtitle: "Review what was learned. Keep what helps the next task.") {
                HStack {
                    if let refresh {
                        Button { Task { await refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(!isConnected || isLoading)
                    }
                    AnalysisWorkspaceLauncher(kind: "memory", actions: isConnected ? configurationActions : nil)
                    Button { requestMemoryNavigation { beginDraft(DesktopMemoryDraft(scope: workspaceScope ?? .global)) } } label: { Label("New memory", systemImage: "plus") }
                        .buttonStyle(.borderedProminent).disabled(workspaceActions == nil || !isConnected || draftBusy)
                }
            }
            if !isConnected { workspaceNotice("Disconnected · loaded knowledge may be stale. Connect to edit, approve or launch.") }
            if let error { inlineError(error).padding(.horizontal, 24).padding(.vertical, 8) }
            if let draft {
                DesktopMemoryEditor(draft: Binding(get: { self.draft ?? draft }, set: { self.draft = $0 }),
                    original: originalDraft ?? draft, busy: draftBusy, error: draftError, connected: isConnected,
                    cancel: { requestMemoryNavigation { self.draft = nil } }, save: saveDraft)
            } else {
                DesktopSectionPicker(title: "", items: ["Review", "Library", "Extraction"], selection: $workspaceSection, label: { section in
                    section == "Review" ? "Review · \(pendingCandidates.count + entries.filter { !$0.approved }.count)" : section == "Library" ? "Library · \(Self.mergeEntries(entries.filter(\.approved), with: activeMemories).count)" : section
                })
                if workspaceSection == "Extraction" { desktopExtraction }
                else {
                    HSplitView {
                        desktopMemoryList.frame(minWidth: 285, idealWidth: 370, maxWidth: 430)
                        desktopMemoryDetail.frame(minWidth: 340, maxWidth: .infinity)
                    }
                }
            }
        }.background(DesktopTheme.surface)
    }
    private var desktopObservedBody: some View {
        desktopContent
            .onAppear { ensureSelection() }
            .onChange(of: entries.map { "\($0.id):\($0.approved)" }) { _, _ in ensureSelection() }
            .onChange(of: activeMemories.map(\.id)) { _, _ in ensureSelection() }
            .onChange(of: pendingCandidates.map(\.id)) { _, _ in ensureSelection() }
            .onChange(of: workspaceSection) { _, _ in detailSection = "Content"; ensureSelection() }
            .onChange(of: workspaceScope) { _, scope in if scope != .repository { workspaceRepository = nil }; ensureSelection() }
            .onChange(of: workspaceRepository) { _, repo in if repo != nil { workspaceScope = .repository }; ensureSelection() }
            .onChange(of: searchText) { _, _ in ensureSelection() }
            .onChange(of: selectedItem) { _, value in
                detailSection = "Content"
                switch value { case .memory(let id): onSelectMemory?(id); case .candidate(let id): onSelectCandidate?(id); case nil: break }
            }
            .onChange(of: draft) { _, value in workspaceDirty?(value != nil && value != originalDraft) }
            .onChange(of: draftBusy) { _, value in workspaceBusy?(value) }
            .onDisappear { workspaceDirty?(false); workspaceBusy?(false) }
    }
    private var desktopBody: some View {
        AnyView(desktopObservedBody)
            .confirmationDialog("Discard unsaved memory changes?", isPresented: $showDraftDiscard) {
                Button("Discard changes", role: .destructive) { let action = pendingMemoryNavigation; pendingMemoryNavigation = nil; draft = nil; action?() }
                Button("Keep editing", role: .cancel) { pendingMemoryNavigation = nil }
            }
            .confirmationDialog("\(removeIsActive ? "Delete memory" : "Reject suggestion")?", isPresented: $showMemoryRemoval) {
                Button(removeIsActive ? "Delete memory" : "Reject suggestion", role: .destructive) {
                    if let removalID { if removeIsActive { onDelete(removalID) } else if removeIsCandidate { onRejectCandidate(removalID) } else { onReject(removalID) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text(removeIsActive ? "Remove this active entry. Review its source and usage before deleting." : "Rejecting a suggestion leaves the active library unchanged.") }
    }
    private func workspaceNotice(_ text: String) -> some View {
        Label(text, systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary)
            .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(DesktopTheme.canvas)
    }
    private var desktopMemoryList: some View {
        VStack(spacing: 0) {
            VStack(spacing: 12) {
                TextField("Search path, content, origin…", text: $searchText).textFieldStyle(.roundedBorder).accessibilityIdentifier("memory-search")
                Picker("Scope", selection: $workspaceScope) {
                    Text("All scopes").tag(MemoryScope?.none)
                    ForEach(Array(Set(MemoryScope.allCases + entries.map(\.scope) + pendingCandidates.map(\.scope))).sorted { $0.rawValue < $1.rawValue }, id: \.self) { Text($0.label).tag(Optional($0)) }
                }.accessibilityIdentifier("memory-scope-filter")
                Picker("Repository", selection: $workspaceRepository) {
                    Text("All repositories").tag(String?.none)
                    ForEach(repositoryIDs, id: \.self) { Text(scopeNameLookup?(.repository, $0) ?? $0).tag(Optional($0)) }
                }.accessibilityIdentifier("memory-repository-filter")
            }.controlSize(.small).padding(18)
            Divider()
            if isLoading && entries.isEmpty && activeMemories.isEmpty && pendingCandidates.isEmpty {
                ProgressView("Loading knowledge…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if workspaceSection == "Review" {
                            ForEach(Self.groupCandidatesByOrigin(candidates), id: \.key) { group in
                                originHeader("From \(group.key)", count: group.candidates.count)
                                ForEach(group.candidates) { candidate in desktopCandidateCard(candidate) }
                            }
                            if !pending.isEmpty {
                                originHeader("Legacy suggestions", count: pending.count)
                                ForEach(pending) { memory in desktopEntryCard(memory) }
                            }
                        } else {
                            ForEach(workspaceMemories) { memory in desktopEntryCard(memory) }
                        }
                        if (workspaceSection != "Review" || candidates.isEmpty) && workspaceMemories.isEmpty {
                            ContentUnavailableView("No matching memories", systemImage: "brain", description: Text("Try another scope or search. Agents can propose knowledge for review."))
                        }
                        Text("Repository filters apply to repository-scoped knowledge.").font(.caption2).foregroundStyle(.secondary).padding(.top, 10)
                        Button("Clear filters") { searchText = ""; workspaceScope = nil; workspaceRepository = nil }.font(.caption)
                    }.padding(18)
                }
            }
        }.background(DesktopTheme.canvas)
    }
    private func desktopCandidateCard(_ candidate: MemoryCandidate) -> some View {
        Button { selectedItem = .candidate(candidate.id) } label: {
            workspaceCard(path: candidate.path, badge: candidate.action == .update ? "Update candidate" : "New candidate",
                scope: Self.scopeLabel(scope: candidate.scope, scopeId: candidate.scopeId, repositorySetupId: candidate.repositorySetupId),
                summary: candidate.impactSummary.isEmpty ? candidate.content : candidate.impactSummary,
                meta: "\(Int((candidate.confidence * 100).rounded()))% confidence · \(candidate.kind.rawValue)", selected: selectedItem == .candidate(candidate.id))
        }.buttonStyle(.plain).accessibilityAddTraits(selectedItem == .candidate(candidate.id) ? .isSelected : [])
    }
    private func desktopEntryCard(_ memory: MemoryEntry) -> some View {
        Button { selectedItem = .memory(memory.id) } label: {
            workspaceCard(path: memory.path, badge: memory.approved ? "Active memory" : "Legacy suggestion",
                scope: resolvedScopeLabel(for: memory) ?? Self.scopeLabel(scope: memory.scope, scopeId: memory.scopeId),
                summary: memory.content, meta: "v\(memory.version) · \(Self.originKey(for: memory))", selected: selectedItem == .memory(memory.id))
        }.buttonStyle(.plain).accessibilityAddTraits(selectedItem == .memory(memory.id) ? .isSelected : [])
    }
    private func workspaceCard(path: String, badge: String, scope: String, summary: String, meta: String, selected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(badge).font(.caption2.weight(.medium)).foregroundStyle(DesktopTheme.accent)
            Text(path).font(.system(.callout, design: .monospaced).weight(.medium)).lineLimit(2)
            Text(scope).font(.caption).foregroundStyle(DesktopTheme.accent).lineLimit(2)
            Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            Text(meta).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? DesktopTheme.selection : DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(selected ? DesktopTheme.accent : DesktopTheme.line))
    }
    private var desktopMemoryDetail: some View {
        VStack(spacing: 0) {
            if let candidate = selectedCandidate {
                workspaceDetailHeader(path: candidate.path, scope: Self.scopeLabel(scope: candidate.scope, scopeId: candidate.scopeId, repositorySetupId: candidate.repositorySetupId),
                    id: candidate.id, kind: "\(candidate.action.rawValue.capitalized) candidate", confidence: candidate.confidence, tags: candidate.tags,
                    approve: { onApproveCandidate(candidate.id) }, edit: { beginDraft(DesktopMemoryDraft(candidate: candidate)) }, remove: { requestRemoval(id: candidate.id, active: false, candidate: true) })
                DesktopSectionPicker(title: "", items: ["Content", "Source evidence"], selection: $detailSection, label: { $0 })
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if isLoadingDetails { ProgressView("Loading evidence…").controlSize(.small) }
                        if detailSection == "Source evidence" { evidencePanel(title: "Source evidence", evidence: detailSourceEvidence(for: .candidate(candidate.id), fallback: candidate.sourceEvidence)) }
                        else {
                            contentPanel(candidate.content)
                            infoPanel(title: "Why this was learned", text: candidate.rationale ?? "", systemImage: "quote.bubble")
                            infoPanel(title: "Expected impact", text: candidate.impactSummary, systemImage: "chart.line.uptrend.xyaxis")
                            if let applies = candidate.appliesWhen { infoPanel(title: "Applies when", text: applies, systemImage: "checkmark.circle") }
                            if let avoid = candidate.avoidWhen { infoPanel(title: "Avoid when", text: avoid, systemImage: "minus.circle") }
                            if let target = candidate.targetMemoryId { Text("Updates active memory \(target). Historical usage evidence is retained.").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                            Text("Source pod: \(candidate.createdByPodId ?? "Manual") · \(candidate.kind.rawValue)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }.padding(24)
                }
            } else if let memory = selectedMemory {
                workspaceDetailHeader(path: memory.path, scope: resolvedScopeLabel(for: memory) ?? Self.scopeLabel(scope: memory.scope, scopeId: memory.scopeId),
                    id: memory.id, kind: memory.approved ? "Active memory · v\(memory.version)" : "Legacy suggestion", confidence: memory.confidence, tags: memory.tags,
                    approve: memory.approved ? nil : { onApprove(memory.id) }, edit: memory.approved ? { beginDraft(DesktopMemoryDraft(memory: memory)) } : nil,
                    remove: { requestRemoval(id: memory.id, active: memory.approved, candidate: false) })
                let stale = detailStaleEvidence(for: memory.id), harmful = detailHarmfulEvidence(for: memory.id)
                if Self.hasWarningEvidence(stale: stale, harmful: harmful) {
                    HStack { Label("Stale or harmful usage reported", systemImage: "exclamationmark.triangle.fill"); Spacer(); Button("See evidence") { detailSection = "Source evidence" } }
                        .font(.caption).foregroundStyle(.orange).padding(14).background(Color.orange.opacity(0.08))
                }
                DesktopSectionPicker(title: "", items: memory.approved ? ["Content", "Source evidence", "Usage & impact"] : ["Content", "Source evidence"], selection: $detailSection, label: { $0 })
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if isLoadingDetails { ProgressView("Loading evidence…").controlSize(.small) }
                        if detailSection == "Source evidence" {
                            if Self.hasWarningEvidence(stale: stale, harmful: harmful) { warningPanel(stale: stale, harmful: harmful) }
                            evidencePanel(title: "Source evidence", evidence: detailSourceEvidence(for: .memory(memory.id), fallback: memory.sourceEvidence))
                        } else if detailSection == "Usage & impact" {
                            impactPanel(memory, usage: detailUsage(for: memory.id)); usagePanel(detailUsage(for: memory.id))
                        } else {
                            contentPanel(memory.content)
                            if let rationale = memory.rationale { infoPanel(title: "Why this was learned", text: rationale, systemImage: "quote.bubble") }
                            if let applies = memory.appliesWhen { infoPanel(title: "Applies when", text: applies, systemImage: "checkmark.circle") }
                            if let avoid = memory.avoidWhen { infoPanel(title: "Avoid when", text: avoid, systemImage: "minus.circle") }
                            Text("Source: \(Self.originKey(for: memory)) · Kind: \(memory.kind?.rawValue ?? "Not recorded")").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            if let setup = memory.repositorySetupId { Text("Repository setup: \(setup)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        }
                    }.padding(24)
                }
            } else { ContentUnavailableView("Select knowledge to review", systemImage: "sidebar.right", description: Text("Content, evidence and usage appear here.")) }
        }.background(DesktopTheme.surface)
    }
    private func workspaceDetailHeader(path: String, scope: String, id: String, kind: String, confidence: Double?, tags: [String], approve: (() -> Void)?, edit: (() -> Void)?, remove: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(kind).font(.caption.weight(.medium)).foregroundStyle(DesktopTheme.accent)
                Text(Self.shortId(id)).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                Spacer()
                if let approve { Button("Approve", action: approve).buttonStyle(.borderedProminent).disabled(!isConnected) }
                Menu {
                    if let edit { Button("Edit", action: edit).disabled(!isConnected || workspaceActions == nil) }
                    Button(approve == nil ? "Delete memory" : "Reject suggestion", role: .destructive, action: remove).disabled(!isConnected)
                    Button(copiedId == id ? "Copied ID" : "Copy ID") { copyId(id) }
                } label: { Text("Actions ···") }.menuStyle(.borderlessButton).fixedSize()
            }.controlSize(.small)
            Text(path).font(.system(size: 23, weight: .medium, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Text(scope + (confidence.map { " · \(Int(($0 * 100).rounded()))% confidence" } ?? "")).font(.caption).foregroundStyle(DesktopTheme.accent).textSelection(.enabled)
            if !tags.isEmpty { FlowTags(tags: tags) }
        }.padding(24)
    }
    private var desktopExtraction: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("How knowledge reached the queue").font(.title2.weight(.semibold))
                Text("Recent extraction attempts. A no-candidate result is valid; reviewer failures remain explicit.").font(.callout).foregroundStyle(.secondary)
                TextField("Search profile, pod, status or reason…", text: $searchText).textFieldStyle(.roundedBorder)
                if visibleExtractionAttempts.isEmpty { ContentUnavailableView("No matching attempts", systemImage: "lightbulb", description: Text("Extraction diagnostics appear after an eligible task is reviewed.")) }
                ForEach(visibleExtractionAttempts) { attempt in
                    DesktopPanel(title: attempt.profileName) {
                        HStack { Label(attempt.status.label, systemImage: attemptIcon(attempt.status)).foregroundStyle(attemptColor(attempt.status)); Spacer(); Text(Self.shortId(attempt.podId)).font(.system(.caption, design: .monospaced)) }
                        Text(Self.humanReadableAttemptReason(attempt.reason)).textSelection(.enabled)
                        if !attempt.signals.isEmpty { Text(attempt.signals.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }.padding(28)
        }.background(DesktopTheme.canvas)
    }
    private func beginDraft(_ value: DesktopMemoryDraft) { draftError = nil; originalDraft = value; draft = value }
    private func requestMemoryNavigation(_ action: @escaping () -> Void) {
        guard !draftBusy else { return }
        if draft != nil && draft != originalDraft { pendingMemoryNavigation = action; showDraftDiscard = true } else { action() }
    }
    private func requestRemoval(id: String, active: Bool, candidate: Bool) { removalID = id; removeIsActive = active; removeIsCandidate = candidate; showMemoryRemoval = true }
    private func saveDraft() {
        guard let value = draft, value.isValid, let workspaceActions, isConnected, !draftBusy else { return }
        draftBusy = true; draftError = nil
        Task { @MainActor in
            defer { draftBusy = false }
            do {
                if let candidate = value.candidate, let update = value.candidateUpdate { try await workspaceActions.updateCandidate(candidate.id, update) }
                else if let id = value.memoryID { try await workspaceActions.update(id, value.content) }
                else {
                    try await workspaceActions.create(value.scope, value.scope == .global ? nil : value.scopeID.trimmingCharacters(in: .whitespacesAndNewlines), value.path.trimmingCharacters(in: .whitespacesAndNewlines), value.content)
                    workspaceSection = "Library"; workspaceScope = value.scope; workspaceRepository = value.scope == .repository ? value.scopeID.trimmingCharacters(in: .whitespacesAndNewlines) : nil; searchText = ""
                }
                draft = nil; originalDraft = nil; ensureSelection()
            } catch { draftError = error.localizedDescription }
        }
    }
}
