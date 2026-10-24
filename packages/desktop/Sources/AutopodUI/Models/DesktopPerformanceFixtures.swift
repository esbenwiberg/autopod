import AutopodClient
import Foundation
import SwiftUI

/// Synthetic, offline inputs shared by native timing tests and explicit Preview mode.
@MainActor
public enum DesktopPerformanceFixtures {
    public static let date = Date(timeIntervalSince1970: 1_792_800_000)
    public static let pods: [Pod] = (0..<1_000).map { index in
        let id = String(format: "perf-%04d", index)
        let repository = index % 10
        return Pod(
            id: id, status: index < 5 ? .running : index < 10 ? .validated : .complete,
            branch: "fixture/\(id)", profileName: "fixture-\(repository)",
            task: String(repeating: "Synthetic task evidence. ", count: 84).prefix(2_000).description,
            model: "Fixture", startedAt: date.addingTimeInterval(-Double(index)),
            updatedAt: date.addingTimeInterval(-Double(index)),
            validationChecks: ValidationChecks(smoke: true, setup: true, build: true,
                tests: true, lint: true, review: true, buildOutput: "Fixture build passed",
                reviewReasoning: "Fixture review passed"),
            plan: SessionPlan(summary: "Fixture plan", steps: ["Inspect", "Verify"]),
            taskSummary: TaskSummary(actualSummary: "Fixture summary for \(id)", deviations: []),
            profileSnapshot: Profile(name: "fixture-\(repository)",
                repoUrl: "https://github.com/fixture/repository-\(repository).git"),
            briefTitle: "Fixture pod \(id)",
            readinessReview: ReadinessReview(status: .ready, summary: "Fixture readiness",
                computedAt: date, areas: [], findings: []))
    }
    public static let events: [AgentEvent] = (0..<300).map {
        AgentEvent(id: $0 + 1, timestamp: date.addingTimeInterval(Double($0)),
            type: .status, summary: "Fixture event \($0)")
    }
    public static let diff: DiffApiResponse = {
        let json = #"{"files":[{"path":"fixture.txt","status":"modified","diff":"diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after"}],"stats":{"added":1,"removed":1,"changed":1},"commits":[]}"#
        // A fixed literal; a malformed fixture must fail rather than silently lose coverage.
        return try! JSONDecoder().decode(DiffApiResponse.self, from: Data(json.utf8))
    }()
    private static let diffs = Dictionary(uniqueKeysWithValues: pods.map { ($0.id, diff) })

    public static func mainView(selection: Binding<String?>) -> MainView {
        MainView(pods: pods, selectedSessionId: selection, isConnected: true,
            connectionLabel: "Offline performance fixture", actions: .preview,
            selectedSessionEvents: events, eventsForPod: { _ in events },
            sessionDiffs: diffs, loadFiles: { _ in [] }, loadArtifacts: { _ in [] },
            loadValidationHistory: { _ in [] })
    }
}
