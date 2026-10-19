import AppKit
import AutopodClient
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationRepositoryInteractionTests {
  @Test func commandsHealthAndFullTimeoutRangeSaveReopenAndReset() async throws {
    let fixture = try RepositoryEditorFixture()
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("setup-section-Commands") }
    #expect(!host.enabled("configuration-editor-save"))
    try host.editField(placeholder: "Prepare command", text: "npx pnpm install --frozen-lockfile")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "SAST command", text: "npx pnpm audit")
    host.window.makeFirstResponder(nil)
    try host.press("setup-section-Validation")
    try await host.wait { host.has("setup-web-ui") }
    try host.press("setup-web-ui")
    try host.editField(placeholder: "Health path", text: "/ready")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "Build timeout", text: "86400")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "Health timeout", text: "1")
    host.window.makeFirstResponder(nil)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.setup["prepareCommand"] == .string("npx pnpm install --frozen-lockfile"))
    #expect(fixture.setup["sastCommand"] == .string("npx pnpm audit"))
    #expect(fixture.setup["hasWebUi"] == .bool(false))
    #expect(fixture.setup["healthPath"] == .string("/ready"))
    #expect(fixture.setup["buildTimeout"] == .number(86400))
    #expect(fixture.setup["healthTimeout"] == .number(1))
    try fixture.export("commands")
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.has("setup-section-Validation") }
    #expect(!reopened.enabled("configuration-editor-save"))
    try reopened.press("setup-section-Validation")
    try await reopened.wait { reopened.has("setup-timeout-reset-buildTimeout") }
    try reopened.press("setup-timeout-reset-buildTimeout")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.setup["buildTimeout"] == nil, "Schema defaults are omitted, never null")
    #expect(fixture.setup["healthTimeout"] == .number(1))
  }

  @Test func addsSmokePageAndAssertionFromEmptyThenRemovesWithoutChangingOthers() async throws {
    let fixture = try RepositoryEditorFixture()
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("setup-section-Smoke pages") }
    try host.press("setup-section-Smoke pages")
    try host.press("setup-page-add")
    try await host.wait { host.has("setup-page-path-0") }
    try host.editField(placeholder: "Page path", text: "/dashboard")
    host.window.makeFirstResponder(nil)
    try host.press("setup-assertion-add-0")
    try await host.wait { host.has("setup-assertion-selector-0-0") }
    try host.editField(placeholder: "CSS selector", text: "main h1")
    host.window.makeFirstResponder(nil)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.setup["smokePages"]?.array?[0]["path"] == .string("/dashboard"))
    #expect(fixture.setup["smokePages"]?.array?[0]["assertions"]?.array?[0]["selector"] == .string("main h1"))
    #expect(fixture.setup["smokePages"]?.array?[0]["assertions"]?.array?[0]["type"] == .string("exists"))
    try fixture.export("smoke-pages")
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.has("setup-section-Smoke pages") }
    try reopened.press("setup-section-Smoke pages")
    try await reopened.wait { reopened.has("setup-assertion-remove-0-0") }
    #expect(!reopened.enabled("configuration-editor-save"))
    try reopened.press("setup-assertion-remove-0-0")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.setup["smokePages"]?.array?[0]["assertions"] == .array([]))
    #expect(fixture.setup["smokePages"]?.array?[0]["path"] == .string("/dashboard"))
  }

  @Test func valueMapAddsLiteralAndCredentialRejectsDuplicateAndPreservesOtherEntries() async throws {
    let fixture = try RepositoryEditorFixture()
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("setup-section-Variables") }
    try host.press("setup-section-Variables")
    try host.editField(placeholder: "Entry name", text: "FEED_TOKEN")
    host.window.makeFirstResponder(nil)
    try host.press("setup-env-add")
    try await host.wait { host.has("setup-env-value-FEED_TOKEN") }
    try host.press("setup-env-source-FEED_TOKEN")
    try await host.wait { host.has("setup-env-value-FEED_TOKEN") }
    try host.editField(placeholder: "Credential ID for FEED_TOKEN", text: "sample-feed")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "Entry name", text: "EXISTING")
    host.window.makeFirstResponder(nil)
    try host.press("setup-env-add")
    try await host.wait { host.has("setup-env-value-EXISTING") }
    try host.editField(placeholder: "Value for EXISTING", text: "keep")
    host.window.makeFirstResponder(nil)
    try host.editField(placeholder: "Entry name", text: "EXISTING")
    host.window.makeFirstResponder(nil)
    #expect(!host.enabled("setup-env-add"))
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.setup["buildEnv"]?["FEED_TOKEN"] == .object(["secretId": .string("sample-feed")]))
    #expect(fixture.setup["buildEnv"]?["EXISTING"] == .object(["value": .string("keep")]))
    try fixture.export("environment")
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.has("setup-section-Variables") }
    try reopened.press("setup-section-Variables")
    try await reopened.wait { reopened.has("setup-env-remove-FEED_TOKEN") }
    #expect(!reopened.enabled("configuration-editor-save"))
    #expect(reopened.containsText("sample-feed"))
    try reopened.press("setup-env-remove-FEED_TOKEN")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.setup["buildEnv"]?["FEED_TOKEN"] == nil)
    #expect(fixture.setup["buildEnv"]?["EXISTING"]?["value"] == .string("keep"))
  }

  @Test func registryCreatesFromEmptySavesReferenceAndClearsOptionalFieldsCorrectly() async throws {
    let fixture = try RepositoryEditorFixture()
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("setup-section-PR & registries") }
    try host.press("setup-section-PR & registries")
    try host.press("setup-registry-add")
    try await host.wait { host.has("setup-registry-url-0") }
    for (placeholder, value) in [("Registry HTTPS URL", "https://registry.example.com/npm"), ("npm scope (optional)", "@sample"), ("Registry credential ID", "sample-registry"), ("Expiry YYYY-MM-DD (optional)", "2027-01-31")] {
      try host.editField(placeholder: placeholder, text: value); host.window.makeFirstResponder(nil)
    }
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.setup["integrations"]?["privateRegistries"]?.array?[0]["credential"] == .object(["secretId": .string("sample-registry")]))
    #expect(fixture.setup["integrations"]?["privateRegistries"]?.array?[0]["expiresAt"] == .string("2027-01-31"))
    try fixture.export("registries")
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.has("setup-section-PR & registries") }
    try reopened.press("setup-section-PR & registries")
    try await reopened.wait { reopened.has("setup-registry-url-0") }
    #expect(!reopened.enabled("configuration-editor-save"))
    for placeholder in ["Registry credential ID", "Expiry YYYY-MM-DD (optional)", "npm scope (optional)"] {
      try reopened.editField(placeholder: placeholder, text: ""); reopened.window.makeFirstResponder(nil)
    }
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    let registry = fixture.setup["integrations"]?["privateRegistries"]?.array?[0]
    #expect(registry?["credential"] == .null)
    #expect(registry?["expiresAt"] == .null)
    #expect(registry?["scope"] == nil)
    #expect(registry?["url"] == .string("https://registry.example.com/npm"))
  }

  @Test func unrelatedRepositorySetupAndIntegrationDataSurviveEdits() async throws {
    let fixture = try RepositoryEditorFixture()
    fixture.document.payload["futureRepository"] = .bool(true)
    fixture.updateSetup {
      $0["futureSetup"] = .string("retain")
      $0["integrations"] = .object(["futureIntegration": .bool(true), "privateRegistries": .array([])])
    }
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("setup-section-PR & registries") }
    try host.press("setup-section-PR & registries")
    try host.press("setup-registry-add")
    try host.editField(placeholder: "Registry HTTPS URL", text: "https://registry.example.com")
    host.window.makeFirstResponder(nil)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["futureRepository"] == .bool(true))
    #expect(fixture.setup["futureSetup"] == .string("retain"))
    #expect(fixture.setup["integrations"]?["futureIntegration"] == .bool(true))
    #expect(fixture.document.payload["setups"]?.array?[1]["name"] == .string("Other setup"))
    #expect(fixture.document.payload["defaultSetupId"] == .string("default"))
  }

  @Test(arguments: [900.0, 1400.0], [false, true]) func repositorySectionsFitAndRender(width: Double, light: Bool) async throws {
    let fixture = try RepositoryEditorFixture()
    fixture.updateSetup {
      $0["buildCommand"] = .string("npx pnpm build")
      $0["prepareCommand"] = .string("npx pnpm install --frozen-lockfile")
      $0["sastCommand"] = .string("npx pnpm audit")
      $0["buildEnv"] = .object(["APP_ENV": .object(["value": .string("test")]), "FEED_TOKEN": .object(["secretId": .string("sample-feed")])])
      $0["smokePages"] = .array([.object(["path": .string("/dashboard"), "assertions": .array([.object(["selector": .string("main h1"), "type": .string("text_contains"), "value": .string("Dashboard")]), .object(["selector": .string(".result"), "type": .string("count"), "value": .string("3")])])])])
      $0["integrations"] = .object(["prProvider": .string("ado"), "privateRegistries": .array([.object(["type": .string("nuget"), "url": .string("https://packages.example.com/nuget/v3/index.json"), "credential": .object(["secretId": .string("sample-registry")]), "expiresAt": .string("2027-01-31")])])])
    }
    let host = fixture.host(width: width, light: light)
    defer { host.close() }
    try await host.wait { host.has("setup-section-Commands") }
    for section in [RepositorySetupSection.commands, .validation, .pages, .variables, .registries] {
      try host.press("setup-section-\(section.id)")
      #expect(host.hosting.fittingSize.width <= width)
      #expect(!host.enabled("configuration-editor-save"))
      try host.capture("repository-\(section.id)-\(Int(width))-\(light ? "light" : "dark")")
    }
  }
}

@MainActor private final class RepositoryEditorFixture {
  var document: ConfigurationDocument
  var writes: [ConfigurationWriteRequest] = []
  var setup: ConfigurationJSON { document.payload["setups"]?.array?.first ?? .object([:]) }
  init() throws {
    let setup: ConfigurationJSON = .object(["id": .string("default"), "name": .string("Backend service"), "defaultBranch": .string("main")])
    let value: ConfigurationJSON = .object(["id": .string("repo"), "kind": .string("repository"), "name": .string("acme/backend"), "revision": .number(1), "createdAt": .string("2026-10-19T00:00:00Z"), "updatedAt": .string("2026-10-19T00:00:00Z"), "archived": .bool(false), "payload": .object([
      "provider": .string("github"), "remote": .string("https://github.com/acme/backend.git"), "usualProfileId": .null, "defaultSetupId": .string("default"), "trustedSetupIds": .array([]), "setups": .array([setup, .object(["id": .string("other"), "name": .string("Other setup"), "defaultBranch": .string("main")])]),
    ])])
    document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(value.formatted().utf8))
  }
  func updateSetup(_ edit: (inout [String: ConfigurationJSON]) -> Void) {
    var current = setup.object ?? [:]; edit(&current)
    var setups = document.payload["setups"]?.array ?? []; setups[0] = .object(current); document.payload["setups"] = .array(setups)
  }
  func export(_ name: String) throws {
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_LAUNCH_RENDER_DIR"] else { return }
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    try ConfigurationJSON.object(document.payload).formatted().write(toFile: "\(directory)/saved-\(name).json", atomically: true, encoding: .utf8)
  }
  func host(width: Double = 1120, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("No daemon in repository editor test")
    let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {}, resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
      #expect(request.expectedRevision == self.document.revision)
      self.writes.append(request); self.document.payload = request.payload; self.document.revision += 1; return self.document
    }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .repository, document: document, actions: actions, onClose: {}, initialArea: .setups).tint(DesktopTheme.accent), width: width, light: light)
  }
}
