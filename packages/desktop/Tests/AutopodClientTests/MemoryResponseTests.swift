import Foundation
import Testing
@testable import AutopodClient

@Test func legacyMemoryEntryDecodesWithDefaultsAndSessionCompatibility() throws {
    let json = """
    {
      "id": "mem-legacy",
      "scope": "profile",
      "scopeId": "ios-app",
      "path": "/conventions/git.md",
      "content": "Use small commits.",
      "contentSha256": "abc",
      "version": 2,
      "approved": true,
      "createdBySessionId": "pod-old",
      "createdAt": "2026-05-01T00:00:00Z",
      "updatedAt": "2026-05-01T01:00:00Z"
    }
    """.data(using: .utf8)!

    let entry = try JSONDecoder().decode(MemoryEntry.self, from: json)

    #expect(entry.id == "mem-legacy")
    #expect(entry.kind == nil)
    #expect(entry.tags.isEmpty)
    #expect(entry.sourceEvidence.isEmpty)
    #expect(entry.createdByPodId == "pod-old")
    #expect(entry.createdBySessionId == "pod-old")
}

@Test func extendedMemoryEntryDecodes() throws {
    let json = """
    {
      "id": "mem-new",
      "scope": "profile",
      "scopeId": "ios-app",
      "path": "/gotchas/build.md",
      "content": "Run codegen before build.",
      "contentSha256": "def",
      "rationale": "Prevents stale generated files.",
      "kind": "gotcha",
      "tags": ["build", "codegen"],
      "appliesWhen": "Generated files changed",
      "avoidWhen": null,
      "confidence": 0.91,
      "sourceEvidence": [{
        "podId": "pod-1",
        "signal": "validation_failure",
        "excerpt": "Missing generated file",
        "severity": "high",
        "createdAt": "2026-05-02T00:00:00Z"
      }],
      "impactSummary": "Avoids validation failures.",
      "version": 1,
      "approved": true,
      "createdByPodId": "pod-1",
      "createdAt": "2026-05-02T00:00:00Z",
      "updatedAt": "2026-05-02T00:00:00Z"
    }
    """.data(using: .utf8)!

    let entry = try JSONDecoder().decode(MemoryEntry.self, from: json)

    #expect(entry.kind == .gotcha)
    #expect(entry.tags == ["build", "codegen"])
    #expect(entry.confidence == 0.91)
    #expect(entry.sourceEvidence.first?.severity == .high)
    #expect(entry.impactSummary == "Avoids validation failures.")
}

@Test func memoryCandidateDecodesUnknownEnumsConservatively() throws {
    let json = """
    {
      "id": "cand-1",
      "action": "merge",
      "targetMemoryId": null,
      "scope": "profile",
      "scopeId": "ios-app",
      "path": "/workflow/release.md",
      "content": "Tag releases from main.",
      "rationale": "Release automation expects main.",
      "kind": "future_kind",
      "tags": ["release"],
      "appliesWhen": null,
      "avoidWhen": null,
      "confidence": 0.77,
      "sourceEvidence": [],
      "impactSummary": "Keeps release tags consistent.",
      "status": "queued_for_review",
      "createdByPodId": "pod-2",
      "fallbackReason": null,
      "createdAt": "2026-05-03T00:00:00Z",
      "updatedAt": "2026-05-03T00:00:00Z"
    }
    """.data(using: .utf8)!

    let candidate = try JSONDecoder().decode(MemoryCandidate.self, from: json)

    #expect(candidate.action == .unknown("merge"))
    #expect(candidate.kind == .unknown("future_kind"))
    #expect(candidate.status == .unknown("queued_for_review"))
}

@Test func memoryUsageHistoryDecodes() throws {
    let json = """
    {
      "memoryId": "mem-1",
      "events": [{
        "id": "usage-1",
        "memoryId": "mem-1",
        "podId": "pod-1",
        "kind": "summary_reported",
        "outcome": "harmful_stale",
        "reason": "The package changed.",
        "relevanceReason": "Matched package upgrade task.",
        "createdAt": "2026-05-04T00:00:00Z"
      }]
    }
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(MemoryUsageResponse.self, from: json)

    #expect(response.memoryId == "mem-1")
    #expect(response.events.first?.kind == .summaryReported)
    #expect(response.events.first?.outcome == .harmfulStale)
}

@Test func memoryAnalyticsDecodes() throws {
    let json = """
    {
      "days": 30,
      "summary": {
        "selectedCount": 3,
        "injectedCount": 2,
        "readCount": 1,
        "searchedCount": 4,
        "appliedCount": 2,
        "notApplicableCount": 1,
        "harmfulStaleCount": 1,
        "notReportedCount": 0,
        "candidateCount": 5,
        "approvedCandidateCount": 2
      },
      "impact": {
        "cohortSize": 6,
        "comparisonCohortSize": 8,
        "qualityDelta": 0.15,
        "validationFailureDelta": -0.2,
        "fixAttemptDelta": -1.0,
        "escalationDelta": null,
        "costDeltaUsd": -0.35,
        "reworkDelta": -0.5,
        "firstPassRateDelta": 0.25,
        "throughputDelta": -2.5
      },
      "topMemories": [{
        "memoryId": "mem-1",
        "path": "/gotchas/build.md",
        "impactSummary": "Avoids build failures.",
        "selectedCount": 3,
        "injectedCount": 2,
        "appliedCount": 2,
        "harmfulStaleCount": 1
      }]
    }
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(MemoryAnalyticsResponse.self, from: json)

    #expect(response.days == 30)
    #expect(response.summary.candidateCount == 5)
    #expect(response.impact.validationFailureDelta == -0.2)
    #expect(response.topMemories.first?.memoryId == "mem-1")
}

@Test func daemonAPIMemoryPathConstruction() throws {
    let api = DaemonAPI(baseURL: URL(string: "http://localhost:3100")!, token: "token")

    let candidates = try api.makeRequestURL(
        "/memory/candidates",
        query: ["scopeId": "ios-app", "status": "pending"]
    )
    let analytics = try api.makeRequestURL("/pods/analytics/memory", query: ["days": "30"])

    let candidateComponents = URLComponents(url: candidates, resolvingAgainstBaseURL: false)
    #expect(candidateComponents?.path == "/memory/candidates")
    #expect(candidateComponents?.queryItems?.contains(URLQueryItem(name: "scopeId", value: "ios-app")) == true)
    #expect(candidateComponents?.queryItems?.contains(URLQueryItem(name: "status", value: "pending")) == true)

    let analyticsComponents = URLComponents(url: analytics, resolvingAgainstBaseURL: false)
    #expect(analyticsComponents?.path == "/pods/analytics/memory")
    #expect(analyticsComponents?.queryItems == [URLQueryItem(name: "days", value: "30")])
}

@Test func memoryCandidateCreatedEventParses() throws {
    let json = """
    {
      "type": "memory.candidate_created",
      "timestamp": "2026-05-03T00:00:00Z",
      "podId": "pod-2",
      "candidate": {
        "id": "cand-1",
        "action": "create",
        "targetMemoryId": null,
        "scope": "profile",
        "scopeId": "ios-app",
        "path": "/workflow/release.md",
        "content": "Tag releases from main.",
        "rationale": "Release automation expects main.",
        "kind": "workflow",
        "tags": ["release"],
        "appliesWhen": null,
        "avoidWhen": null,
        "confidence": 0.77,
        "sourceEvidence": [],
        "impactSummary": "Keeps release tags consistent.",
        "status": "pending",
        "createdByPodId": "pod-2",
        "fallbackReason": null,
        "createdAt": "2026-05-03T00:00:00Z",
        "updatedAt": "2026-05-03T00:00:00Z"
      }
    }
    """.data(using: .utf8)!

    let raw = try JSONDecoder().decode(RawSystemEvent.self, from: json)
    let event = SystemEvent.parse(raw)

    switch event {
    case .memoryCandidateCreated(let podId, let candidate):
        #expect(podId == "pod-2")
        #expect(candidate.id == "cand-1")
    default:
        Issue.record("Expected memoryCandidateCreated event")
    }
}
