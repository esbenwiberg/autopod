import Foundation
import AutopodClient
import AutopodUI

/// Manages memory entries — loading, approving, rejecting, creating, and deleting.
@Observable
@MainActor
public final class MemoryStore {

    public private(set) var entries: [MemoryEntry] = []
    public private(set) var isLoading = false
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

    public var pendingCount: Int { pendingSuggestions.count }

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
                let session = try await api.listMemories(scope: "session", scopeId: scopeId, approvedOnly: false)
                entries = fetched + profile + session
            } else {
                entries = fetched
            }
        } catch {
            print("[MemoryStore] Failed to load memories: \(error)")
            self.error = error.localizedDescription
        }
        isLoading = false
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
                    version: e.version, approved: true,
                    createdBySessionId: e.createdBySessionId,
                    createdAt: e.createdAt, updatedAt: e.updatedAt
                )
            }
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
                    version: e.version + 1, approved: e.approved,
                    createdBySessionId: e.createdBySessionId,
                    createdAt: e.createdAt, updatedAt: e.updatedAt
                )
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
        } catch {
            print("[MemoryStore] Failed to create memory: \(error)")
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
    }
}
