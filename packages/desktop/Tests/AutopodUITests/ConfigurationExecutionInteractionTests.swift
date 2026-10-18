import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationExecutionInteractionTests {
  @Test(arguments: [false, true])
  func createsNetworkPolicyFromAbsentOrNullAndSavesHosts(null: Bool) async throws {
    let fixture = try ExecutionEditorFixture()
    if null {
      var execution = fixture.profile.payload["execution"]?.object ?? [:]
      execution["networkPolicy"] = .null; fixture.profile.payload["execution"] = .object(execution)
    }
    let before = fixture.profile.payload
    let host = fixture.host(.network)
    defer { host.close() }
    try await host.wait { host.has("configuration-network-custom") }
    #expect(!host.has("configuration-network-mode"))
    try host.press("configuration-network-custom")
    try await host.wait { host.has("configuration-network-mode") }
    try host.press("configuration-network-packages")
    try host.press("configuration-network-replace-defaults")
    try host.press("configuration-list-Allowed hosts-add")
    try await host.wait { host.has("configuration-list-Allowed hosts-0") }
    try host.editField(placeholder: "Value", text: "api.example.com")
    host.window.makeFirstResponder(nil)
    try host.capture("profile-network-configured")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    let policy = try #require(fixture.profile.payload["execution"]?["networkPolicy"])
    #expect(policy["enabled"] == .bool(true))
    #expect(policy["mode"] == .string("restricted"))
    #expect(policy["allowPackageManagers"] == .bool(true))
    #expect(policy["replaceDefaults"] == .bool(true))
    #expect(policy["allowedHosts"] == .array([.string("api.example.com")]))
    #expect(fixture.profile.payload["execution"]?["main"] == before["execution"]?["main"])
    #expect(fixture.profile.payload["futureField"] == before["futureField"])
    #expect(fixture.writes[0].expectedRevision == 1)
    let reopened = fixture.host(.network)
    defer { reopened.close() }
    try await reopened.wait { reopened.has("configuration-list-Allowed hosts-0") }
    #expect(reopened.containsText("api.example.com"))
    try reopened.press("configuration-network-custom")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.profile.payload["execution"]?["networkPolicy"] == .null)
  }

  @Test func sidecarHealthTimeoutHasANumericDefaultAndEditsWithoutNull() async throws {
    var fields: [String: ConfigurationJSON] = ["id": .string("database"), "type": .string("postgres")]
    let host = LaunchComposerHost(EnvironmentSidecarEditor(fields: Binding(get: { fields }, set: { fields = $0 })), width: 680)
    defer { host.close() }
    try await host.wait { host.containsText("Health timeout (ms)") }
    try host.editField(placeholder: "Health timeout (ms)", text: "45000")
    host.window.makeFirstResponder(nil)
    #expect(fields["healthTimeoutMs"] == .number(45000))
    #expect(fields["id"] == .string("database"))
  }

  @Test func savedPolicyEditsPreserveOtherPolicyAndExecutionFields() async throws {
    let fixture = try ExecutionEditorFixture()
    var execution = try #require(fixture.profile.payload["execution"]?.object)
    execution["networkPolicy"] = .object([
      "enabled": .bool(true), "mode": .string("restricted"),
      "allowedHosts": .array([.string("saved.example.com")]), "futurePolicyField": .string("retain"),
    ])
    fixture.profile.payload["execution"] = .object(execution)
    let host = fixture.host(.network)
    defer { host.close() }
    try await host.wait { host.has("configuration-network-packages") }
    try host.press("configuration-network-packages")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.profile.payload["execution"]?["networkPolicy"]?["futurePolicyField"] == .string("retain"))
    #expect(fixture.profile.payload["execution"]?["networkPolicy"]?["allowedHosts"] == .array([.string("saved.example.com")]))
    #expect(fixture.profile.payload["execution"]?["futureExecutionField"] == .string("retain"))
  }

  @Test func selectsSidecarFromEmptyMapAllocatesAndReopens() async throws {
    let fixture = try ExecutionEditorFixture()
    let host = fixture.host(.sidecars)
    defer { host.close() }
    try await host.wait { host.has("configuration-sidecar-required-database") }
    #expect(host.containsText("Always starts with this Environment"))
    try host.press("configuration-sidecar-required-database")
    try await host.wait { host.containsText("Memory (GB)") }
    try host.pressLabel("Memory (GB)")
    try await host.wait { host.containsText("Use backend resource defaults") }
    try host.editField(placeholder: "Memory (GB)", text: "3")
    // Commit the number formatter before saving the document.
    host.window.makeFirstResponder(nil)
    try host.capture("profile-sidecars-selected")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.profile.payload["requiredSidecarIds"] == .array([.string("database")]))
    #expect(fixture.profile.payload["execution"]?["sidecars"]?["database"]?["memoryGb"] == .number(3))
    #expect(fixture.profile.payload["execution"]?["futureExecutionField"] == .string("retain"))
    let reopened = fixture.host(.sidecars)
    defer { reopened.close() }
    try await reopened.wait { reopened.has("configuration-sidecar-reset-database") }
    try reopened.press("configuration-sidecar-reset-database")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.profile.payload["requiredSidecarIds"] == .array([.string("database")]))
    #expect(fixture.profile.payload["execution"]?["sidecars"]?["database"] == nil)
  }

  @Test func missingSidecarsAreVisibleAndExplicitRemovalPreservesOtherConfiguration() async throws {
    let fixture = try ExecutionEditorFixture()
    fixture.profile.payload["requiredSidecarIds"] = .array([.string("missing")])
    var execution = try #require(fixture.profile.payload["execution"]?.object)
    execution["sidecars"] = .object(["missing": .object(["memoryGb": .number(2)])])
    fixture.profile.payload["execution"] = .object(execution)
    let host = fixture.host(.sidecars)
    defer { host.close() }
    try await host.wait { host.has("configuration-sidecar-remove-missing") }
    #expect(!host.enabled("configuration-editor-save"))
    try host.press("configuration-sidecar-remove-missing")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.profile.payload["requiredSidecarIds"] == .array([]))
    #expect(fixture.profile.payload["execution"]?["sidecars"] == .object([:]))
    #expect(fixture.profile.payload["execution"]?["futureExecutionField"] == .string("retain"))
  }

  @Test func emptyEnvironmentOffersDefinitionEditorAndUnsupportedBackendRetainsSavedLimits() async throws {
    let fixture = try ExecutionEditorFixture()
    fixture.environment.payload["sidecars"] = .array([])
    var opened: String?
    let host = fixture.host(.sidecars, open: { opened = $0.id })
    defer { host.close() }
    try await host.wait { host.has("configuration-sidecar-definitions") }
    #expect(host.containsText("No sidecars defined"))
    try host.capture("profile-sidecars-empty")
    try host.press("configuration-sidecar-definitions")
    #expect(opened == fixture.environment.id)
    fixture.profile.payload["execution"] = .object([
      "target": .string("sandbox"), "main": .object(["cpus": .number(2), "storageGb": .number(10)]),
    ])
    let unsupported = fixture.host(.execution)
    defer { unsupported.close() }
    try await unsupported.wait { unsupported.containsText("CPUs: 2 · unsupported") }
    #expect(unsupported.containsText("Storage (GB): 10 · unsupported"))
    #expect(!unsupported.enabled("configuration-editor-save"))
    try unsupported.capture("profile-unsupported-allocations")
  }
}

@MainActor private final class ExecutionEditorFixture {
  var profile: ConfigurationDocument
  var environment: ConfigurationDocument
  var writes: [ConfigurationWriteRequest] = []
  init() throws {
    environment = try Self.document(.environment, id: "environment", payload: ["sidecars": .array([
      .object(["id": .string("database"), "type": .string("postgres"), "version": .string("17"), "startup": .string("on-demand")]),
      .object(["id": .string("cache"), "type": .string("redis"), "version": .string("7"), "startup": .string("always")]),
    ])])
    profile = try Self.document(.profile, id: "profile", payload: [
      "environmentId": .string("environment"), "aiId": .string("ai"), "workflowId": .string("workflow"),
      "execution": .object(["target": .string("local"), "main": .object(["memoryGb": .number(4)]),
        "sidecars": .object([:]), "futureExecutionField": .string("retain")]),
      "futureField": .object(["preserve": .bool(true)]),
    ])
  }
  func host(_ area: ConfigurationEditorArea, open: ((ConfigurationDocument) -> Void)? = { _ in }) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("No daemon in configuration interaction test")
    let caps: ConfigurationJSON = .object(["execution": .array([
      .object(["target": .string("local"), "available": .bool(true), "sidecars": .bool(true),
        "maxCpus": .number(8), "maxTotalMemoryGb": .number(16)]),
      .object(["target": .string("sandbox"), "available": .bool(true), "sidecars": .bool(false)]),
    ])])
    let actions = LaunchConfigurationActions(documents: [profile, environment], capabilities: caps, reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
        #expect(request.expectedRevision == self.profile.revision)
        self.writes.append(request)
        self.profile.payload = request.payload; self.profile.revision += 1
        return self.profile
      }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .profile, document: profile, actions: actions,
      onClose: {}, onOpenSidecarDefinitions: open, initialArea: area).tint(DesktopTheme.accent), width: 1120)
  }
  static func document(_ kind: ConfigurationKind, id: String, payload: [String: ConfigurationJSON]) throws -> ConfigurationDocument {
    let value: ConfigurationJSON = .object(["id": .string(id), "kind": .string(kind.rawValue), "name": .string(kind == .environment ? "Backend services" : "Backend delivery"),
      "revision": .number(1), "createdAt": .string("2026-10-18T00:00:00Z"), "updatedAt": .string("2026-10-18T00:00:00Z"),
      "archived": .bool(false), "payload": .object(payload)])
    return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(value.formatted().utf8))
  }
}
