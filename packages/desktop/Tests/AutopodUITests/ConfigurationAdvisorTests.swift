import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@Test func advisorTabsAndAbsentJSONPreserveCompatibility() throws {
    #expect(ConfigurationEditorArea.areas(for: .ai) == [.main, .reviewer, .advisor, .failover, .advanced])
    let old: [String: ConfigurationJSON] = ["main": .object(["model": .string("main")])]
    #expect(ConfigurationAdvisorSelection.mode(old) == "follow-reviewer")
    let reopened = try JSONDecoder().decode([String: ConfigurationJSON].self, from: JSONEncoder().encode(old))
    #expect(reopened == old)
    #expect(reopened["advisor"] == nil)
}

@Test(arguments: ["follow-main", "follow-reviewer", "independent"])
func advisorModeAndIndependentFailoverRoundTrip(_ mode: String) throws {
    let target: [String: ConfigurationJSON] = ["providerAccountId": .string("advisor"), "runtime": .string("codex"), "model": .string("advisor-model"), "reasoningEffort": .string("high")]
    var route = target
    route["failover"] = .array([.object(target.merging(["providerAccountId": .string("fallback")]) { _, new in new })])
    route["maxHops"] = .number(1)
    var payload: [String: ConfigurationJSON] = ["main": .object(target), "reviewer": .object(["mode": .string("follow-main")])]
    payload["advisor"] = ConfigurationAdvisorSelection.value(mode: mode, initialRoute: route)
    let reopened = try JSONDecoder().decode([String: ConfigurationJSON].self, from: JSONEncoder().encode(payload))
    #expect(reopened == payload)
    #expect(ConfigurationAdvisorSelection.mode(reopened) == mode)
    #expect(reopened["advisor"]?["route"] == (mode == "independent" ? .object(route) : nil))
    #expect(reopened["reviewer"] == .object(["mode": .string("follow-main")]))
}

@MainActor @Test func independentAdvisorTargetAndFailoverSaveAndReopen() async throws {
    let target: [String: ConfigurationJSON] = ["providerAccountId": .string("advisor"), "runtime": .string("codex"), "model": .string("advisor-model"), "reasoningEffort": .string("high")]
    var route = target
    route["failover"] = .array([.object(target)])
    route["maxHops"] = .number(1)
    let raw: ConfigurationJSON = .object(["id": .string("advisor-test"), "kind": .string("ai"), "name": .string("Advisor test"), "revision": .number(1), "createdAt": .string("created"), "updatedAt": .string("updated"), "archived": .bool(false), "payload": .object([
        "main": .object(target.merging(["failover": .array([]), "maxHops": .number(0)]) { _, new in new }),
        "reviewer": .object(["mode": .string("follow-main")]),
        "advisor": ConfigurationAdvisorSelection.value(mode: "independent", initialRoute: route),
    ])])
    var document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(raw.formatted().utf8))
    var writes = 0
    func host(_ area: ConfigurationEditorArea) -> LaunchComposerHost {
        let unavailable = DaemonError.badRequest("Offline Advisor editor test")
        let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {},
            resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
                document.payload = request.payload; document.revision += 1; writes += 1
                return document
            }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
            loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
        return LaunchComposerHost(ConfigurationEditorSheet(kind: .ai, document: document, actions: actions, onClose: {}, initialArea: area), width: 1120)
    }
    let editor = host(.advisor)
    defer { editor.close() }
    try await editor.wait { editor.containsText("Independent Advisor") }
    try editor.editField(placeholder: "Model", text: "advisor-edited")
    editor.window.makeFirstResponder(nil)
    try editor.press("configuration-editor-save")
    try await editor.wait { writes == 1 }
    #expect(document.payload["advisor"]?["route"]?["model"] == .string("advisor-edited"))
    let failover = host(.failover)
    defer { failover.close() }
    try await failover.wait { failover.containsText("Advisor failover") }
    try failover.editField(placeholder: "Model", text: "advisor-fallback-edited")
    failover.window.makeFirstResponder(nil)
    try failover.press("configuration-editor-save")
    try await failover.wait { writes == 2 }
    #expect(document.payload["advisor"]?["route"]?["failover"]?.array?.first?["model"] == .string("advisor-fallback-edited"))
    #expect(document.payload["main"]?["model"] == .string("advisor-model"))
    #expect(document.payload["reviewer"] == .object(["mode": .string("follow-main")]))
    let reopened = host(.advisor)
    defer { reopened.close() }
    try await reopened.wait { reopened.containsText("advisor-edited") }
    #expect(!reopened.enabled("configuration-editor-save"))
}
