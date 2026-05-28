import Testing
@testable import AutopodClient
@testable import AutopodUI

@Test func memoryWorkbenchGroupsPendingCandidatesByOrigin() {
    let older = makeCandidate(id: "cand-old", podId: "pod-a", updatedAt: "2026-05-20T00:00:00Z")
    let newer = makeCandidate(id: "cand-new", podId: "pod-b", updatedAt: "2026-05-21T00:00:00Z")
    let sibling = makeCandidate(id: "cand-sibling", podId: "pod-a", updatedAt: "2026-05-22T00:00:00Z")

    let groups = MemoryManagementView.groupCandidatesByOrigin([older, newer, sibling])

    #expect(groups.map(\.key) == ["pod-a", "pod-b"])
    #expect(groups.first?.candidates.map(\.id) == ["cand-old", "cand-sibling"])
}

@Test func memoryWorkbenchFiltersActiveMemoriesByScopeAndQuery() {
    let global = makeMemory(id: "global", scope: .global, path: "/conventions/commits.md", content: "Use direct commits")
    let profile = makeMemory(id: "profile", scope: .profile, path: "/gotchas/migrations.md", content: "Migration prefixes must be unique")

    let result = MemoryManagementView.filteredEntries(
        [global, profile],
        scope: .profile,
        query: "prefixes"
    )

    #expect(result.map(\.id) == ["profile"])
}

@Test func memoryWorkbenchPrefersCandidateSelectionThenKeepsValidSelection() {
    let candidate = makeCandidate(id: "cand-1")
    let memory = makeMemory(id: "mem-1")

    let initial = MemoryManagementView.preferredSelection(
        current: nil,
        candidates: [candidate],
        memories: [memory]
    )
    let kept = MemoryManagementView.preferredSelection(
        current: .memory("mem-1"),
        candidates: [candidate],
        memories: [memory]
    )

    #expect(initial == .candidate("cand-1"))
    #expect(kept == .memory("mem-1"))
}

@Test func memoryWorkbenchSelectionFallsBackWhenCurrentItemIsNotVisible() {
    let visibleCandidate = makeCandidate(id: "cand-visible")
    let visibleMemory = makeMemory(id: "mem-visible")

    let candidateFallback = MemoryManagementView.preferredSelection(
        current: .memory("mem-hidden"),
        candidates: [visibleCandidate],
        memories: [visibleMemory]
    )
    let memoryFallback = MemoryManagementView.preferredSelection(
        current: .candidate("cand-hidden"),
        candidates: [],
        memories: [visibleMemory]
    )

    #expect(candidateFallback == .candidate("cand-visible"))
    #expect(memoryFallback == .memory("mem-visible"))
}

@Test func memoryWorkbenchImpactCountsUsageOutcomes() {
    let counts = MemoryManagementView.usageImpactCounts([
        makeUsage(id: "u1", kind: .selected),
        makeUsage(id: "u2", kind: .injected),
        makeUsage(id: "u3", kind: .read),
        makeUsage(id: "u4", kind: .summaryReported, outcome: .applied),
    ])

    #expect(counts.selected == 1)
    #expect(counts.injected == 1)
    #expect(counts.read == 1)
    #expect(counts.applied == 1)
}

@Test func memoryWorkbenchShowsWarningStateForStaleOrHarmfulEvidence() {
    #expect(MemoryManagementView.hasWarningEvidence(stale: [], harmful: []) == false)
    #expect(MemoryManagementView.hasWarningEvidence(stale: [makeUsage(id: "stale", outcome: .notApplicable)], harmful: []) == true)
    #expect(MemoryManagementView.hasWarningEvidence(stale: [], harmful: [makeUsage(id: "harm", outcome: .harmfulStale)]) == true)
}

@Test func memoryWorkbenchRejectsDetailPayloadForDifferentSelection() {
    #expect(
        MemoryManagementView.detailPayloadMatches(
            selection: .memory("mem-2"),
            selectedMemoryDetailId: "mem-1",
            selectedCandidateDetailId: nil
        ) == false
    )
    #expect(
        MemoryManagementView.detailPayloadMatches(
            selection: .candidate("cand-1"),
            selectedMemoryDetailId: nil,
            selectedCandidateDetailId: "cand-1"
        ) == true
    )
}

@Test func memoryWorkbenchFiltersUsageToSelectedMemory() {
    let selected = makeUsage(id: "u1", memoryId: "mem-1")
    let stale = makeUsage(id: "u2", memoryId: "mem-2")

    let result = MemoryManagementView.usageForMemory([selected, stale], memoryId: "mem-1")

    #expect(result.map(\.id) == ["u1"])
}

@Test func memoryWorkbenchShowsExtractionAttemptsOnWorkbenchEmptyStates() {
    let attempt = MemoryExtractionAttempt(
        id: "attempt-1",
        podId: "pod-1",
        profileName: "backend",
        status: .reviewerUnavailable,
        reason: "openai_auth_unavailable",
        score: 0.3,
        signals: ["pr_fix_attempts:2"]
    )

    let profileAttempts = MemoryManagementView.filteredExtractionAttempts(
        [attempt],
        scope: .profile,
        query: "openai"
    )
    let globalAttempts = MemoryManagementView.filteredExtractionAttempts(
        [attempt],
        scope: .global,
        query: ""
    )

    let podAttempts = MemoryManagementView.filteredExtractionAttempts(
        [attempt],
        scope: .pod,
        query: ""
    )

    #expect(profileAttempts.map(\.id) == ["attempt-1"])
    #expect(globalAttempts.map(\.id) == ["attempt-1"])
    #expect(podAttempts.isEmpty)
    #expect(MemoryManagementView.humanReadableAttemptReason("openai_auth_unavailable").contains("OpenAI"))
}

private func makeMemory(
    id: String,
    scope: MemoryScope = .profile,
    path: String = "/gotchas/test.md",
    content: String = "Remember this"
) -> MemoryEntry {
    MemoryEntry(
        id: id,
        scope: scope,
        scopeId: scope == .global ? nil : "backend",
        path: path,
        content: content,
        approved: true,
        updatedAt: "2026-05-22T00:00:00Z"
    )
}

private func makeCandidate(
    id: String,
    podId: String = "pod-a",
    updatedAt: String = "2026-05-22T00:00:00Z"
) -> MemoryCandidate {
    MemoryCandidate(
        id: id,
        action: .create,
        targetMemoryId: nil,
        scope: .profile,
        scopeId: "backend",
        path: "/gotchas/test.md",
        content: "Use the approved migration prefix sequence.",
        rationale: "Repeated migration issue",
        kind: .gotcha,
        tags: ["daemon"],
        appliesWhen: nil,
        avoidWhen: nil,
        confidence: 0.84,
        sourceEvidence: [],
        impactSummary: "Would reduce repeated migration failures.",
        status: .pending,
        createdByPodId: podId,
        fallbackReason: nil,
        createdAt: "2026-05-20T00:00:00Z",
        updatedAt: updatedAt
    )
}

private func makeUsage(
    id: String,
    memoryId: String = "mem-1",
    kind: MemoryUsageKind = .selected,
    outcome: MemoryUsageOutcome? = nil
) -> MemoryUsageEvent {
    MemoryUsageEvent(
        id: id,
        memoryId: memoryId,
        podId: "pod-1",
        kind: kind,
        outcome: outcome,
        reason: "reason",
        relevanceReason: nil,
        createdAt: "2026-05-22T00:00:00Z"
    )
}
