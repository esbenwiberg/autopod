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
    public var selectedUsage: [MemoryUsageEvent]
    public var selectedSourceEvidence: [MemorySourceEvidence]
    public var selectedStaleEvidence: [MemoryUsageEvent]
    public var selectedHarmfulEvidence: [MemoryUsageEvent]
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

    @State private var selectedScope: MemoryScope = .global
    @State private var searchText = ""
    @State private var selectedItem: MemoryWorkbenchSelection?
    @State private var showingCreate = false
    @State private var editingEntry: MemoryEntry?
    @State private var editingCandidate: MemoryCandidate?
    @State private var viewingEntry: MemoryEntry?
    @State private var copiedId: String?
    @State private var scanProfile: String?
    @State private var isLaunchingScan = false

    public init(
        entries: [MemoryEntry],
        activeMemories: [MemoryEntry] = [],
        pendingCandidates: [MemoryCandidate] = [],
        selectedUsage: [MemoryUsageEvent] = [],
        selectedSourceEvidence: [MemorySourceEvidence] = [],
        selectedStaleEvidence: [MemoryUsageEvent] = [],
        selectedHarmfulEvidence: [MemoryUsageEvent] = [],
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
        onScanMemories: ((String) -> Void)? = nil
    ) {
        self.entries = entries
        self.activeMemories = activeMemories
        self.pendingCandidates = pendingCandidates
        self.selectedUsage = selectedUsage
        self.selectedSourceEvidence = selectedSourceEvidence
        self.selectedStaleEvidence = selectedStaleEvidence
        self.selectedHarmfulEvidence = selectedHarmfulEvidence
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
    }

    private var displayedScope: MemoryScope {
        scopeFilter ?? selectedScope
    }

    private var filteredEntries: [MemoryEntry] {
        Self.filteredEntries(entries, scope: displayedScope, query: searchText)
    }

    private var pending: [MemoryEntry] { filteredEntries.filter { !$0.approved } }
    private var approved: [MemoryEntry] {
        let source = activeMemories.isEmpty ? entries.filter(\.approved) : activeMemories
        return Self.filteredEntries(source, scope: displayedScope, query: searchText)
    }

    private var candidates: [MemoryCandidate] {
        Self.filteredCandidates(pendingCandidates, scope: displayedScope, query: searchText)
    }

    private var selectedMemory: MemoryEntry? {
        guard case .memory(let id) = selectedItem else { return nil }
        return approved.first { $0.id == id } ?? entries.first { $0.id == id }
    }

    private var selectedCandidate: MemoryCandidate? {
        guard case .candidate(let id) = selectedItem else { return nil }
        return candidates.first { $0.id == id } ?? pendingCandidates.first { $0.id == id }
    }

    public var body: some View {
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
        .background(Color(nsColor: .controlBackgroundColor))
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
                        if onScanMemories != nil && scopeFilter == nil && !profileNames.isEmpty {
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
        let grouped = Dictionary(grouping: entries) { $0.createdBySessionId ?? "Manual" }
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
                subtitle: "\(candidate.action.rawValue) candidate · \(candidate.kind.rawValue)",
                confidence: candidate.confidence,
                tags: candidate.tags
            )
            if let rationale = candidate.rationale, !rationale.isEmpty {
                infoPanel(title: "Rationale", text: rationale, systemImage: "quote.bubble")
            }
            infoPanel(title: "Impact", text: candidate.impactSummary, systemImage: "chart.line.uptrend.xyaxis")
            contentPanel(candidate.content)
            evidencePanel(title: "Source Evidence", evidence: selectedSourceEvidence.isEmpty ? candidate.sourceEvidence : selectedSourceEvidence)
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
            detailHeader(
                title: memory.path,
                subtitle: "active memory · v\(memory.version)",
                confidence: memory.confidence,
                tags: memory.tags
            )
            if let rationale = memory.rationale, !rationale.isEmpty {
                infoPanel(title: "Rationale", text: rationale, systemImage: "quote.bubble")
            }
            contentPanel(memory.content)
            if Self.hasWarningEvidence(stale: selectedStaleEvidence, harmful: selectedHarmfulEvidence) {
                warningPanel(stale: selectedStaleEvidence, harmful: selectedHarmfulEvidence)
            }
            evidencePanel(
                title: "Source Evidence",
                evidence: selectedSourceEvidence.isEmpty ? memory.sourceEvidence : selectedSourceEvidence
            )
            impactPanel(memory)
            usagePanel(selectedUsage)
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

    private var scanSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Analyze & Fix")
                .font(.subheadline.weight(.semibold))

            VStack(alignment: .leading, spacing: 12) {
                Text("Launch a workspace pod that reviews all memories and drafts a fix plan for gotchas and issues in your repos.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    Picker("Profile", selection: $scanProfile) {
                        Text("Select a profile…").tag(nil as String?)
                        ForEach(profileNames, id: \.self) { name in
                            Text(name).tag(name as String?)
                        }
                    }
                    .frame(width: 180)

                    Button {
                        guard let profile = scanProfile else { return }
                        isLaunchingScan = true
                        onScanMemories?(profile)
                        isLaunchingScan = false
                    } label: {
                        if isLaunchingScan {
                            ProgressView()
                                .controlSize(.small)
                                .padding(.horizontal, 4)
                        } else {
                            Label("Open Memory Workspace", systemImage: "brain")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                    .disabled(isLaunchingScan || scanProfile == nil)
                }
            }
            .padding(16)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Candidate card

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
                    Text("source: pod \(shortId(podId))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
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
                if let scopeId = entry.scopeId,
                   entry.scope != .global,
                   let scopeName = scopeNameLookup?(entry.scope, scopeId) {
                    Text("· \(scopeName)")
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
                if let sid = entry.createdBySessionId {
                    Text("by \(sid)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

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
        isSelected ? Color.accentColor.opacity(0.08) : Color(nsColor: .controlBackgroundColor)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "brain")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("No memories")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Agents can suggest memories for review, or you can create one manually.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
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
                .background(Color(nsColor: .controlBackgroundColor))
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
        .background(Color(nsColor: .controlBackgroundColor))
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
        .background(Color(nsColor: .controlBackgroundColor))
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

    private func impactPanel(_ memory: MemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Impact", systemImage: "chart.bar")
                .font(.headline)
            let counts = Self.usageImpactCounts(selectedUsage)
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
        .background(Color(nsColor: .controlBackgroundColor))
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
        .background(Color(nsColor: .controlBackgroundColor))
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

    static func usageImpactCounts(_ usage: [MemoryUsageEvent]) -> (selected: Int, injected: Int, read: Int, applied: Int) {
        (
            selected: usage.filter { $0.kind == .selected }.count,
            injected: usage.filter { $0.kind == .injected }.count,
            read: usage.filter { $0.kind == .read }.count,
            applied: usage.filter { $0.outcome == .applied }.count
        )
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

    private func shortId(_ id: String) -> String {
        id.count > 8 ? String(id.prefix(8)) : id
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
                            Text(scope == .profile ? "Profile name" : "Pod ID")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField(scope == .profile ? "my-app" : "abc12345", text: $scopeId)
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
