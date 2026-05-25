import Foundation
import AutopodClient
import AutopodUI

/// Manages memory entries — loading, approving, rejecting, creating, and deleting.
@Observable
@MainActor
public final class MemoryStore {

    public private(set) var entries: [MemoryEntry] = []
    public private(set) var activeMemories: [MemoryEntry] = []
    public private(set) var pendingCandidates: [MemoryCandidate] = []
    public private(set) var selectedMemory: MemoryEntry?
    public private(set) var selectedCandidate: MemoryCandidate?
    public private(set) var selectedUsage: [MemoryUsageEvent] = []
    public private(set) var selectedSourceEvidence: [MemorySourceEvidence] = []
    public private(set) var selectedStaleEvidence: [MemoryUsageEvent] = []
    public private(set) var selectedHarmfulEvidence: [MemoryUsageEvent] = []
    public private(set) var analytics: MemoryAnalyticsResponse?
    public private(set) var isLoading = false
    public private(set) var isLoadingDetails = false
    public private(set) var isLoadingAnalytics = false
    public var error: String?

    private var api: DaemonAPI?

    public init() {}

    public func configure(api: DaemonAPI) {
        self.api = api
    }

    // MARK: - Derived

    public var pendingSuggestions: [MemoryEntry] {
        entries.filter { !$0.approved }
    }

    public var approvedEntries: [MemoryEntry] {
        entries.filter { $0.approved }
    }

    public var pendingCount: Int { pendingSuggestions.count + pendingCandidates.count }

    // MARK: - Load

    public func loadMemories(scope: MemoryScope? = nil, scopeId: String? = nil) async {
        guard let api else { return }
        isLoading = true
        error = nil
        do {
            let scopeStr = scope?.rawValue ?? "global"
            let fetched = try await api.listMemories(scope: scopeStr, scopeId: scopeId, approvedOnly: false)
            if scope == nil {
                // Load all three scopes and merge
                let profile = try await api.listMemories(scope: "profile", scopeId: scopeId, approvedOnly: false)
                let pod = try await api.listMemories(scope: "pod", scopeId: scopeId, approvedOnly: false)
                entries = fetched + profile + pod
            } else {
                entries = fetched
            }
            activeMemories = entries.filter(\.approved)
        } catch {
            print("[MemoryStore] Failed to load memories: \(error)")
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    public func loadWorkbench(profileName: String, analyticsDays: Int = 30) async {
        await loadActiveMemories(scopeId: profileName)
        await loadPendingCandidates(scopeId: profileName)
        await loadAnalytics(days: analyticsDays)
    }

    public func loadPendingCandidates(scopeId: String) async {
        guard let api else { return }
        isLoading = true
        error = nil
        do {
            pendingCandidates = try await api.listMemoryCandidates(scopeId: scopeId, status: .pending)
        } catch {
            print("[MemoryStore] Failed to load memory candidates: \(error)")
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    public func loadActiveMemories(scopeId: String? = nil) async {
        guard let api else { return }
        isLoading = true
        error = nil
        do {
            let global = try await api.listMemories(scope: "global", approvedOnly: true)
            let profile = try await api.listMemories(scope: "profile", scopeId: scopeId, approvedOnly: true)
            activeMemories = global + profile
            entries = mergeEntries(entries, with: activeMemories)
        } catch {
            print("[MemoryStore] Failed to load active memories: \(error)")
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    public func loadDetails(memoryId: String) async {
        guard let api else { return }
        isLoadingDetails = true
        error = nil
        selectedMemory = entries.first(where: { $0.id == memoryId })
            ?? activeMemories.first(where: { $0.id == memoryId })
        do {
            async let usage = api.getMemoryUsage(memoryId)
            async let sourceEvidence = api.getMemorySourceEvidence(memoryId)
            async let staleEvidence = api.getMemoryStaleEvidence(memoryId)
            async let harmfulEvidence = api.getMemoryHarmfulEvidence(memoryId)
            selectedUsage = try await usage.events
            selectedSourceEvidence = try await sourceEvidence.evidence
            selectedStaleEvidence = try await staleEvidence.evidence
            selectedHarmfulEvidence = try await harmfulEvidence.evidence
        } catch {
            print("[MemoryStore] Failed to load memory details \(memoryId): \(error)")
            self.error = error.localizedDescription
        }
        isLoadingDetails = false
    }

    public func loadCandidateEvidence(_ candidateId: String) async {
        guard let api else { return }
        isLoadingDetails = true
        error = nil
        selectedCandidate = pendingCandidates.first { $0.id == candidateId }
        do {
            let response = try await api.getMemoryCandidateSourceEvidence(candidateId)
            selectedSourceEvidence = response.evidence
        } catch {
            print("[MemoryStore] Failed to load candidate evidence \(candidateId): \(error)")
            self.error = error.localizedDescription
        }
        isLoadingDetails = false
    }

    public func loadAnalytics(days: Int = 30) async {
        guard let api else { return }
        isLoadingAnalytics = true
        error = nil
        do {
            analytics = try await api.getMemoryAnalytics(days: days)
        } catch {
            print("[MemoryStore] Failed to load memory analytics: \(error)")
            self.error = error.localizedDescription
        }
        isLoadingAnalytics = false
    }

    // MARK: - Mutations

    public func approve(_ id: String) async {
        guard let api else { return }
        do {
            try await api.approveMemory(id)
            if let idx = entries.firstIndex(where: { $0.id == id }) {
                let e = entries[idx]
                entries[idx] = MemoryEntry(
                    id: e.id, scope: e.scope, scopeId: e.scopeId,
                    path: e.path, content: e.content, contentSha256: e.contentSha256,
                    rationale: e.rationale,
                    kind: e.kind, tags: e.tags,
                    appliesWhen: e.appliesWhen, avoidWhen: e.avoidWhen,
                    confidence: e.confidence, sourceEvidence: e.sourceEvidence,
                    impactSummary: e.impactSummary,
                    version: e.version, approved: true,
                    createdByPodId: e.createdByPodId,
                    createdAt: e.createdAt, updatedAt: e.updatedAt
                )
            }
            activeMemories = entries.filter(\.approved)
        } catch {
            print("[MemoryStore] Failed to approve memory \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func reject(_ id: String) async {
        guard let api else { return }
        do {
            try await api.rejectMemory(id)
            entries.removeAll { $0.id == id }
            activeMemories.removeAll { $0.id == id }
        } catch {
            print("[MemoryStore] Failed to reject memory \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func update(_ id: String, content: String) async {
        guard let api else { return }
        do {
            try await api.updateMemory(id, content: content)
            if let idx = entries.firstIndex(where: { $0.id == id }) {
                let e = entries[idx]
                entries[idx] = MemoryEntry(
                    id: e.id, scope: e.scope, scopeId: e.scopeId,
                    path: e.path, content: content, contentSha256: e.contentSha256,
                    rationale: e.rationale,
                    kind: e.kind, tags: e.tags,
                    appliesWhen: e.appliesWhen, avoidWhen: e.avoidWhen,
                    confidence: e.confidence, sourceEvidence: e.sourceEvidence,
                    impactSummary: e.impactSummary,
                    version: e.version + 1, approved: e.approved,
                    createdByPodId: e.createdByPodId,
                    createdAt: e.createdAt, updatedAt: e.updatedAt
                )
                activeMemories = mergeEntries(activeMemories, with: [entries[idx]])
            }
        } catch {
            print("[MemoryStore] Failed to update memory \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func delete(_ id: String) async {
        guard let api else { return }
        do {
            try await api.deleteMemory(id)
            entries.removeAll { $0.id == id }
            activeMemories.removeAll { $0.id == id }
            if selectedMemory?.id == id { selectedMemory = nil }
        } catch {
            print("[MemoryStore] Failed to delete memory \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func create(scope: MemoryScope, scopeId: String?, path: String, content: String) async {
        guard let api else { return }
        do {
            let entry = try await api.createMemory(scope: scope.rawValue, scopeId: scopeId, path: path, content: content)
            entries.insert(entry, at: 0)
            if entry.approved {
                activeMemories.insert(entry, at: 0)
            }
        } catch {
            print("[MemoryStore] Failed to create memory: \(error)")
            self.error = error.localizedDescription
        }
    }

    public func approveCandidate(_ id: String) async {
        guard let api else { return }
        do {
            let candidate = try await api.approveMemoryCandidate(id)
            upsertCandidate(candidate)
        } catch {
            print("[MemoryStore] Failed to approve memory candidate \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func rejectCandidate(_ id: String) async {
        guard let api else { return }
        do {
            let candidate = try await api.rejectMemoryCandidate(id)
            upsertCandidate(candidate)
        } catch {
            print("[MemoryStore] Failed to reject memory candidate \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    public func updateCandidate(_ id: String, updates: MemoryCandidateUpdate) async {
        guard let api else { return }
        do {
            let candidate = try await api.updateMemoryCandidate(id, updates: updates)
            upsertCandidate(candidate)
        } catch {
            print("[MemoryStore] Failed to update memory candidate \(id): \(error)")
            self.error = error.localizedDescription
        }
    }

    // MARK: - Event handling

    /// Called by EventStream when a memory.suggestion_created event arrives.
    public func handleSuggestionCreated(_ entry: MemoryEntry) {
        // Add or update the entry
        if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[idx] = entry
        } else {
            entries.insert(entry, at: 0)
        }
        if entry.approved {
            activeMemories = mergeEntries(activeMemories, with: [entry])
        }
    }

    public func handleCandidateCreated(_ candidate: MemoryCandidate) {
        upsertCandidate(candidate)
    }

    public func handleCandidateUpdated(_ candidate: MemoryCandidate) {
        upsertCandidate(candidate)
    }

    private func upsertCandidate(_ candidate: MemoryCandidate) {
        if candidate.status != .pending {
            pendingCandidates.removeAll { $0.id == candidate.id }
            if selectedCandidate?.id == candidate.id {
                selectedCandidate = candidate
            }
            return
        }
        if let idx = pendingCandidates.firstIndex(where: { $0.id == candidate.id }) {
            pendingCandidates[idx] = candidate
        } else {
            pendingCandidates.insert(candidate, at: 0)
        }
        if selectedCandidate?.id == candidate.id {
            selectedCandidate = candidate
        }
    }

    private func mergeEntries(_ existing: [MemoryEntry], with incoming: [MemoryEntry]) -> [MemoryEntry] {
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
}
