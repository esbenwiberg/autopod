import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop

@MainActor
@Test func memoryStoreHandlesLegacySuggestionEvent() {
    let store = MemoryStore()
    let entry = MemoryEntry(
        id: "mem-1",
        scope: .profile,
        scopeId: "ios-app",
        path: "/gotchas/build.md",
        content: "Run codegen first.",
        approved: false,
        createdBySessionId: "pod-1"
    )

    store.handleSuggestionCreated(entry)

    #expect(store.entries.count == 1)
    #expect(store.pendingSuggestions.first?.id == "mem-1")
    #expect(store.pendingCount == 1)
    #expect(store.entries.first?.createdBySessionId == "pod-1")
}

@MainActor
@Test func memoryStoreHandlesCandidateCreatedAndUpdatesInPlace() {
    let store = MemoryStore()
    let original = makeCandidate(id: "cand-1", content: "Old lesson")
    let updated = makeCandidate(id: "cand-1", content: "Updated lesson")

    store.handleCandidateCreated(original)
    store.handleCandidateUpdated(updated)

    #expect(store.pendingCandidates.count == 1)
    #expect(store.pendingCandidates.first?.content == "Updated lesson")
    #expect(store.pendingCount == 1)
}

@MainActor
@Test func memoryStoreRemovesNonPendingCandidateEvents() {
    let store = MemoryStore()
    store.handleCandidateCreated(makeCandidate(id: "cand-1", status: .pending))
    store.handleCandidateCreated(makeCandidate(id: "cand-1", status: .approved))

    #expect(store.pendingCandidates.isEmpty)
    #expect(store.pendingCount == 0)
}

@MainActor
@Test func memoryStoreAppliesApprovedUpdateCandidateEventToCachedMemory() {
    let store = MemoryStore()
    let entry = MemoryEntry(
        id: "mem-1",
        scope: .profile,
        scopeId: "ios-app",
        path: "/gotchas/codegen.md",
        content: "Old content.",
        kind: .gotcha,
        tags: ["old"],
        version: 1,
        approved: true,
        createdByPodId: "pod-0",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z"
    )
    let candidate = MemoryCandidate(
        id: "cand-1",
        action: .update,
        targetMemoryId: "mem-1",
        scope: .profile,
        scopeId: "ios-app",
        path: "/gotchas/codegen.md",
        content: "Run codegen before building.",
        rationale: "Avoids generated-file drift.",
        kind: .workflow,
        tags: ["codegen"],
        appliesWhen: "Generated files changed",
        avoidWhen: nil,
        confidence: 0.9,
        sourceEvidence: [
            MemorySourceEvidence(
                podId: "pod-1",
                signal: "validation_failure",
                excerpt: "Generated file missing",
                severity: .high,
                createdAt: "2026-05-03T00:00:00Z"
            )
        ],
        impactSummary: "Avoids validation failures.",
        status: .approved,
        createdByPodId: "pod-1",
        fallbackReason: nil,
        createdAt: "2026-05-03T00:00:00Z",
        updatedAt: "2026-05-04T00:00:00Z"
    )

    store.handleSuggestionCreated(entry)
    store.handleCandidateCreated(makeCandidate(id: "cand-1"))
    store.handleCandidateUpdated(candidate)

    #expect(store.pendingCandidates.isEmpty)
    #expect(store.entries.first?.content == "Run codegen before building.")
    #expect(store.entries.first?.kind == .workflow)
    #expect(store.entries.first?.version == 2)
}

private func makeCandidate(
    id: String,
    content: String = "Remember to run codegen.",
    status: MemoryCandidateStatus = .pending
) -> MemoryCandidate {
    MemoryCandidate(
        id: id,
        action: .create,
        targetMemoryId: nil,
        scope: .profile,
        scopeId: "ios-app",
        path: "/gotchas/codegen.md",
        content: content,
        rationale: "Avoids generated-file drift.",
        kind: .gotcha,
        tags: ["codegen"],
        appliesWhen: nil,
        avoidWhen: nil,
        confidence: 0.8,
        sourceEvidence: [],
        impactSummary: "Avoids validation failures.",
        status: status,
        createdByPodId: "pod-1",
        fallbackReason: nil,
        createdAt: "2026-05-03T00:00:00Z",
        updatedAt: "2026-05-03T00:00:00Z"
    )
}
