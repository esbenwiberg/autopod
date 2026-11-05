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
