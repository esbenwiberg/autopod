import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

private let villageNow = Date(timeIntervalSince1970: 1_791_990_000)
private func villagePod(status: PodStatus = .running, interactive: Bool = false) -> Pod {
    Pod(id: "pod-a", status: status, pod: PodConfig(agentMode: interactive ? .interactive : .auto),
        branch: "work", profileName: "webapp", task: "Add the settings page", model: "codex",
        startedAt: villageNow, updatedAt: villageNow)
}
private func villageEvent(_ id: Int = 42, type: AgentEventType = .toolUse,
                          tool: String? = "Edit", at: Date = villageNow) -> AgentEvent {
    AgentEvent(id: id, timestamp: at, type: type, summary: "untrusted summary says tests passed",
        detail: "private output", toolName: tool)
}

@Test func villageUsesDaemonStateOverContradictoryActivity() {
    for status: PodStatus in [.failed, .validating, .awaitingInput, .complete, .paused, .killed] {
        let actor = VillageScene.native(villagePod(status: status), events: [villageEvent()], now: villageNow)
        #expect(actor.status == status.rawValue)
        #expect(actor.activity == nil)
    }
    let running = VillageScene.native(villagePod(), events: [villageEvent(type: .complete)], now: villageNow)
    #expect(running.stage == .working) // Agent completion is not pod completion.
    #expect(running.activity == nil)
}

@Test func villageActivityExpiresWithoutInventingFailureOrCompletion() {
    let actor = VillageScene.native(villagePod(), events: [villageEvent()], now: villageNow.addingTimeInterval(31))
    #expect(actor.stage == .working)
    #expect(actor.activity?.kind == .edit)
    #expect(actor.activity?.isRecent == false)
    let future = VillageScene.native(villagePod(), events: [villageEvent(at: villageNow.addingTimeInterval(60))], now: villageNow)
    #expect(future.activity?.isRecent == false)
}

@Test func villageNewerResultsClearActivityAndReasoningIsNeverSerialized() throws {
    let actor = VillageScene.native(villagePod(), events: [
        villageEvent(), villageEvent(43, type: .toolResult, at: villageNow.addingTimeInterval(1))
    ], now: villageNow.addingTimeInterval(2))
    #expect(actor.activity == nil)
    let privateActor = VillageScene.native(villagePod(), events: [villageEvent(type: .reasoning)], now: villageNow)
    #expect(privateActor.activity == nil)
    let json = String(decoding: try JSONEncoder().encode(privateActor), as: UTF8.self)
    #expect(!json.contains("untrusted summary"))
    #expect(!json.contains("private output"))
}

@Test func villageUnknownToolsStayGenericAndInteractivePodsDoNotPretendToBeAgents() {
    let unknown = VillageScene.native(villagePod(), events: [villageEvent(tool: "new_provider_tool")], now: villageNow)
    #expect(unknown.activity?.kind == .tool)
    let workspace = VillageScene.native(villagePod(interactive: true), events: [villageEvent()], now: villageNow)
    #expect(workspace.interactive)
    #expect(workspace.activity == nil)
    #expect(VillageStage(status: "future_state") == .unknown)
}

@Test func villageManagedPodsAreLifecycleOnlyAndCannotCollideWithNativeIDs() throws {
    let json = #"{"podId":"pod-a","dispatcherAttemptId":"attempt-a","state":"running","providerAccountId":"account","model":"codex","runtime":"codex","executionTarget":"sandbox","reasoning":"high","profileId":"research","profileVersion":1,"providerRequests":1,"consumedTokens":1,"tokenUsageKnown":true,"limitations":[],"artifacts":[],"revoked":false,"stopRequested":false,"observedExit":false,"cleanup":"not-requested","createdAt":1791990000,"lastEventAt":1791990000}"#
    let pod = try JSONDecoder().decode(ManagedPodSummary.self, from: Data(json.utf8))
    let managed = VillageScene.managed(pod)
    let native = VillageScene.native(villagePod(), events: [], now: villageNow)
    #expect(managed.id != native.id)
    #expect(managed.detailLevel == .lifecycle)
    #expect(managed.activity == nil)
    #expect(managed.stage == .working)
    #expect(managed.statusUpdatedAt == native.statusUpdatedAt)
}

@Test func villageSharedFixtureMatchesSwiftProjectionAndJavaScriptWireFormat() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("VillageHost/scene.json")
    let fixture = try JSONDecoder().decode(VillageSnapshot.self, from: Data(contentsOf: file))
    #expect(fixture.schemaVersion == VillageSnapshot.version)
    let native = VillageScene.native(villagePod(), events: [villageEvent()], now: villageNow)
    #expect(fixture.actors.first == native)
    #expect(fixture.actor(id: "managed:pod-a")?.source == .managed)
    let roundTrip = try JSONDecoder().decode(VillageSnapshot.self, from: JSONEncoder().encode(fixture))
    #expect(roundTrip == fixture)
}

@MainActor @Test func villageHasADesktopDestinationAndBundledEntryPoint() {
    #expect(SidebarItem.village.label == "Village")
    #expect(MainView.filterPods([villagePod()], for: .village).isEmpty)
    #expect(VillageWebView.entryURL != nil)
}

@Test func villageHidesExitedManagedAttemptsWithoutHidingActiveValidation() throws {
    let base = #"{"podId":"pod-a","dispatcherAttemptId":"attempt-a","state":"running","providerAccountId":"account","model":"codex","runtime":"codex","executionTarget":"sandbox","reasoning":"high","profileId":"research","profileVersion":1,"providerRequests":1,"consumedTokens":1,"tokenUsageKnown":true,"limitations":[],"artifacts":[],"revoked":false,"stopRequested":false,"observedExit":false,"cleanup":"not-requested","createdAt":1791990000,"lastEventAt":1791990000}"#
    let cases: [(String, Bool, Bool)] = [
        ("running", false, false), ("queued", false, false),
        ("awaiting_input", false, false), ("killing", false, false),
        ("review_required", false, false), ("review_required", true, true),
        ("validated", true, true), ("failed", true, true),
        ("complete", true, true), ("killed", true, true),
        ("validating", true, false), ("handoff", true, false),
    ]
    for (status, exited, finished) in cases {
        var json = try #require(JSONSerialization.jsonObject(with: Data(base.utf8)) as? [String: Any])
        json["state"] = status
        json["observedExit"] = exited
        let pod = try JSONDecoder().decode(ManagedPodSummary.self, from: JSONSerialization.data(withJSONObject: json))
        let actor = VillageScene.managed(pod)
        #expect(actor.isFinished == finished, "Village visibility for \(status), observed exit: \(exited)")
        #expect(actor.status == status) // Filtering must not rewrite lifecycle evidence.
        let decoded = try JSONDecoder().decode(VillageActor.self, from: JSONEncoder().encode(actor))
        #expect(decoded.isFinished == finished)
    }
}
