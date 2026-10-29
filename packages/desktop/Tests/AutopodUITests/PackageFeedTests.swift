import AppKit
import AutopodClient
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct PackageFeedTests {
  @Test func expiryWarningsAndLibraryPlacement() {
    let now = Date(timeIntervalSince1970: 1_761_523_200) // 2025-10-27 UTC
    #expect(PackageFeedEditor.expiryWarning(nil, now: now) == nil)
    #expect(PackageFeedEditor.expiryWarning("2020-01-01", now: now)?.contains("passed") == true)
    #expect(PackageFeedEditor.expiryWarning("2099-01-01", now: now) == nil)
    #expect(PackageFeedEditor.expiryWarning("invalid", now: now)?.contains("valid") == true)
    #expect(ConfigurationKind.packageFeed.endpoint == "/presets/packageFeed")
    #expect(ConfigurationEditorArea.areas(for: .packageFeed) == [.overview, .advanced])
  }
  @Test func storesPATThroughSecureInputWithoutPuttingItInFeedDraft() async throws {
    let fixture = FeedFixture()
    let host = LaunchComposerHost(PackageFeedEditor(payload: Binding(get: { fixture.payload }, set: { fixture.payload = $0 }), document: nil, actions: fixture.actions).padding(24), width: 1000)
    defer { host.close() }
    try await host.wait { host.has("feed-pat") }
    #expect(!host.enabled("feed-store-pat"))
    try host.editField(placeholder: "New PAT (Packaging: Read)", text: "test-only-private-pat")
    host.window.makeFirstResponder(nil)
    try host.press("feed-store-pat")
    try await host.wait { fixture.writes.count == 1 && fixture.payload["credential"] != .null }
    #expect(fixture.writes[0]["value"] == .string("test-only-private-pat"))
    #expect(fixture.writes[0]["purposes"] == .array([.string("registry-read")]))
    #expect(fixture.writes[0]["origins"] == .array([.string("https://packages.example.com")]))
    #expect(fixture.payload["credential"] == .object(["secretId": .string("registry")]))
    #expect(!ConfigurationJSON.object(fixture.payload).formatted().contains("test-only-private-pat"))
    // The backend receipt precedes reloadCredentials/defer and SwiftUI rendering.
    // Wait for the actual secure field to clear, not merely the fixture write.
    try await host.wait { packageFeedPATIsCleared(host) && host.has("feed-store-pat") && !host.enabled("feed-store-pat") }
    #expect(packageFeedPATIsCleared(host), "Native secure field cleared after storing")
    #expect(!host.enabled("feed-store-pat"), "PAT cleared after storing")
    try host.capture("package-feed-pat-stored")
  }
  @Test func connectionTestUsesSavedRevisionAndRejectsUnsavedSettings() async throws {
    let fixture = FeedFixture()
    fixture.payload["credential"] = .object(["secretId": .string("registry")])
    let document = try fixture.document()
    let host = LaunchComposerHost(PackageFeedEditor(payload: Binding(get: { fixture.payload }, set: { fixture.payload = $0 }), document: document, actions: fixture.actions).padding(24), width: 1000)
    defer { host.close() }
    try await host.wait { host.has("feed-test") }
    try host.press("feed-test")
    // Recording a request is not completion of its async reply or rendered UI.
    try await host.wait { fixture.probes == [1] && host.containsText("Fixture authenticated read") }
    #expect(host.containsText("Fixture authenticated read"))
    try host.editField(placeholder: "HTTPS registry URL", text: "https://changed.example.com/")
    host.window.makeFirstResponder(nil)
    try await host.wait { host.has("feed-test") && !host.enabled("feed-test") }
    #expect(!host.enabled("feed-test"))
  }
  @Test func repositorySelectionKeepsLegacyRegistryAndUnknownSelections() async throws {
    let fixture = FeedFixture()
    let feed = try fixture.document()
    fixture.payload = ["privateRegistries": .array([.object(["type": .string("npm"), "url": .string("https://old.example.com/"), "credential": .object(["secretId": .string("old")])])]), "packageFeedIds": .array([.string("missing")])]
    let host = LaunchComposerHost(ConfigurationRegistryEditor(fields: Binding(get: { fixture.payload }, set: { fixture.payload = $0 }), feeds: [feed]).padding(24), width: 1000)
    defer { host.close() }
    try await host.wait { host.has("setup-feed-feed") }
    try host.press("setup-feed-feed")
    #expect(fixture.payload["packageFeedIds"] == .array([.string("missing"), .string("feed")]))
    #expect(fixture.payload["privateRegistries"]?.array?.first?["credential"]?["secretId"] == .string("old"))
  }
}

@MainActor private func packageFeedPATIsCleared(_ host: LaunchComposerHost) -> Bool {
  func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
  host.window.layoutIfNeeded()
  host.hosting.layoutSubtreeIfNeeded()
  let field = descendants(host.hosting).compactMap { $0 as? NSSecureTextField }
    .first { $0.placeholderString == "Replacement PAT" }
  return field?.stringValue.isEmpty == true
}

@MainActor @Observable private final class FeedFixture {
  var payload: [String: ConfigurationJSON] = ["type": .string("npm"), "url": .string("https://packages.example.com/npm/"), "credential": .null, "expiresAt": .null]
  var writes: [ConfigurationJSON] = []
  var probes: [Int] = []
  func document() throws -> ConfigurationDocument {
    let json: ConfigurationJSON = .object(["id": .string("feed"), "name": .string("Company packages"), "kind": .string("packageFeed"), "revision": .number(1), "createdAt": .string("2026-10-26T00:00:00Z"), "updatedAt": .string("2026-10-26T00:00:00Z"), "archived": .bool(false), "payload": .object(payload)])
    return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(json.formatted().utf8))
  }
  var actions: LaunchConfigurationActions {
    let unavailable = DaemonError.badRequest("Fixture only")
    var actions = LaunchConfigurationActions(documents: [], capabilities: .object([:]), reload: {}, resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, _ in throw unavailable }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    actions.listRegistryCredentials = { self.writes.isEmpty ? [] : [.object(["id": .string("registry"), "name": .string("Registry"), "revision": .number(1), "revoked": .bool(false), "purposes": .array([.string("registry-read")]), "origins": .array([.string("https://packages.example.com")])])] }
    actions.saveRegistryCredential = { _, body in self.writes.append(body); return .object(["id": .string("registry"), "revision": .number(1)]) }
    actions.testPackageFeed = { _, revision in self.probes.append(revision); return .object(["status": .string("authenticated"), "message": .string("Fixture authenticated read")]) }
    return actions
  }
}
