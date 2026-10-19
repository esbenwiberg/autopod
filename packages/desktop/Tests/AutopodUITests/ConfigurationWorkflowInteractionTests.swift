import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationWorkflowInteractionTests {
  @Test(arguments: [false, true]) func securityFromAbsentOrNullSavesReopensAndResetsToDefault(null: Bool) async throws {
    let fixture = try WorkflowEditorFixture()
    if null { fixture.document.payload["securityScan"] = .null }
    let host = fixture.host(.security)
    defer { host.close() }
    try await host.wait { host.has("workflow-security-custom") }
    #expect(!host.enabled("configuration-editor-save"))
    try host.capture("workflow-security-default")
    try host.press("workflow-security-custom")
    try await host.wait { host.has("workflow-detector-pii") }
    try host.press("workflow-detector-pii")
    try host.press("workflow-detector-injection")
    try host.press("workflow-checkpoint-provisioning")
    try host.press("workflow-threshold-pii-custom")
    try host.press("workflow-scan-paths-custom")
    try host.press("configuration-list-Paths-add")
    try await host.wait { host.has("configuration-list-Paths-0") }
    try host.editField(placeholder: "Value", text: "docs/**/*.md")
    host.window.makeFirstResponder(nil)
    try host.capture("workflow-security-edited")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    let policy = try #require(fixture.document.payload["securityScan"])
    #expect(policy["detectors"]?["pii"]?["enabled"] == .bool(true))
    #expect(policy["detectors"]?["injection"]?["enabled"] == .bool(true))
    #expect(policy["detectors"]?["pii"]?["threshold"] == nil, "Optional thresholds must be omitted, not null")
    #expect(policy["provisioning"]?["enabled"] == .bool(false))
    #expect(policy["push"]?["onSecret"] == .string("block"))
    #expect(policy["alwaysScanPaths"] == .array([.string("docs/**/*.md")]))
    let reopened = fixture.host(.security)
    defer { reopened.close() }
    try await reopened.wait { reopened.has("configuration-list-Paths-0") }
    #expect(!reopened.enabled("configuration-editor-save"))
    try reopened.press("workflow-security-custom")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.document.payload["securityScan"] == .null)
    #expect(fixture.document.payload["futureField"] == .string("retain"))
  }

  @Test func securityEditsRetainUnknownFieldsAndResetOptionalPathsWithoutNull() async throws {
    let fixture = try WorkflowEditorFixture()
    var policy = ConfigurationWorkflowSecurityEditor.initialPolicy
    policy["futurePolicy"] = .bool(true)
    var detectors = try #require(policy["detectors"]?.object)
    detectors["futureDetector"] = .object(["enabled": .bool(true)])
    policy["detectors"] = .object(detectors)
    policy["alwaysScanPaths"] = .array([])
    fixture.document.payload["securityScan"] = .object(policy)
    let host = fixture.host(.security)
    defer { host.close() }
    try await host.wait { host.has("workflow-scan-paths-custom") }
    try host.press("workflow-scan-paths-custom")
    try host.press("workflow-detector-secrets")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    let saved = fixture.document.payload["securityScan"]
    #expect(saved?["alwaysScanPaths"] == nil)
    #expect(saved?["futurePolicy"] == .bool(true))
    #expect(saved?["detectors"]?["futureDetector"] == .object(["enabled": .bool(true)]))
    #expect(saved?["detectors"]?["secrets"]?["enabled"] == .bool(false))
  }

  @Test(arguments: [false, true]) func escalationUsesFullRangesAndRetainsSavedCustomValues(null: Bool) async throws {
    let fixture = try WorkflowEditorFixture()
    if null { fixture.document.payload["escalation"] = .null }
    let host = fixture.host(.escalation)
    defer { host.close() }
    try await host.wait { host.has("workflow-escalation-custom") }
    #expect(!host.enabled("configuration-editor-save"))
    try host.capture("workflow-escalation-default")
    try host.press("workflow-escalation-custom")
    try await host.wait { host.has("workflow-ask-ai") }
    try host.press("workflow-ask-human")
    try host.press("workflow-ask-ai")
    try host.press("workflow-advisor")
    try host.editField(placeholder: "AI consultation limit", text: "50")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "Human response timeout (seconds)", text: "61")
    host.window.makeFirstResponder(nil)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    let policy = fixture.document.payload["escalation"]
    #expect(policy?["askHuman"] == .bool(false))
    #expect(policy?["askAi"]?["enabled"] == .bool(true))
    #expect(policy?["askAi"]?["maxCalls"] == .number(50))
    #expect(policy?["humanResponseTimeout"] == .number(61))
    #expect(policy?["advisor"]?["enabled"] == .bool(true))
    let reopened = fixture.host(.escalation)
    defer { reopened.close() }
    try await reopened.wait { reopened.has("workflow-human-timeout") }
    #expect(reopened.containsText("61"))
    #expect(!reopened.enabled("configuration-editor-save"))
    try reopened.press("workflow-escalation-custom")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.document.payload["escalation"] == .null)
  }

  @Test func editsPreserveNestedEscalationDataAndBudgetFraction() async throws {
    let fixture = try WorkflowEditorFixture()
    fixture.document.payload["escalation"] = .object([
      "askAi": .object(["enabled": .bool(true), "maxCalls": .number(37), "model": .string("saved-model"), "futureAi": .bool(true)]),
      "humanResponseTimeout": .number(12345), "futureEscalation": .string("retain"),
    ])
    let host = fixture.host(.escalation)
    defer { host.close() }
    try await host.wait { host.has("workflow-ask-ai") }
    #expect(!host.enabled("configuration-editor-save"))
    try host.press("workflow-ask-ai")
    try host.press("configuration-area-Budgets")
    try await host.wait { host.has("workflow-budget-warning") }
    try host.editField(placeholder: "Warn at", text: "95%")
    host.window.makeFirstResponder(nil)
    try host.capture("workflow-budget-edited")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["tokenBudgetWarnAt"]?.number == 0.95)
    #expect(fixture.document.payload["escalation"]?["askAi"]?["enabled"] == .bool(false))
    #expect(fixture.document.payload["escalation"]?["askAi"]?["model"] == .string("saved-model"))
    #expect(fixture.document.payload["escalation"]?["askAi"]?["maxCalls"] == .number(37))
    #expect(fixture.document.payload["escalation"]?["askAi"]?["futureAi"] == .bool(true))
    #expect(fixture.document.payload["escalation"]?["humanResponseTimeout"] == .number(12345))
    #expect(fixture.document.payload["escalation"]?["futureEscalation"] == .string("retain"))
  }

  @Test(arguments: [900.0, 1400.0], [false, true]) func nativeWorkflowLayouts(width: Double, light: Bool) async throws {
    let fixture = try WorkflowEditorFixture()
    fixture.document.payload["securityScan"] = .object(ConfigurationWorkflowSecurityEditor.initialPolicy)
    fixture.document.payload["escalation"] = .object(["askHuman": .bool(true), "askAi": .object(["enabled": .bool(true), "maxCalls": .number(37)]), "humanResponseTimeout": .number(12345)])
    fixture.document.payload["tokenBudget"] = .number(200000)
    for area in [ConfigurationEditorArea.security, .budgets, .escalation] {
      let host = fixture.host(area, width: width, light: light)
      try await host.wait { host.has("configuration-area-Security scans") }
      #expect(host.hosting.fittingSize.width <= width)
      #expect(!host.enabled("configuration-editor-save"))
      try host.capture("workflow-\(area.id)-\(Int(width))-\(light ? "light" : "dark")")
      host.close()
    }
  }
}

@MainActor private final class WorkflowEditorFixture {
  var document: ConfigurationDocument
  var writes: [ConfigurationWriteRequest] = []
  init() throws {
    let value: ConfigurationJSON = .object(["id": .string("workflow"), "kind": .string("workflow"), "name": .string("Backend delivery"),
      "revision": .number(1), "createdAt": .string("2026-10-18T00:00:00Z"), "updatedAt": .string("2026-10-18T00:00:00Z"),
      "archived": .bool(false), "payload": .object(["futureField": .string("retain")])])
    document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(value.formatted().utf8))
  }
  func host(_ area: ConfigurationEditorArea, width: Double = 1120, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("No daemon in Workflow interaction test")
    let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
        #expect(request.expectedRevision == self.document.revision)
        self.writes.append(request); self.document.payload = request.payload; self.document.revision += 1
        return self.document
      }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .workflow, document: document, actions: actions,
      onClose: {}, initialArea: area).tint(DesktopTheme.accent), width: width, light: light)
  }
}
