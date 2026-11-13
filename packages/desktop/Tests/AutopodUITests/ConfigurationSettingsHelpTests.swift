import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationSettingsHelpTests {
  @Test func everyEditorAreaAndRepositorySubareaHasGuidance() {
    for kind in [ConfigurationKind.profile, .repository, .ai, .workflow, .environment, .githubAccess, .toolPack, .packageFeed] {
      for area in ConfigurationEditorArea.areas(for: kind) {
        let id = area.helpTopicID(for: kind)
        #expect(!ConfigurationHelpTopic.topic(id).impact.isEmpty)
        #expect(!ConfigurationHelpTopic.settings(in: id).isEmpty, "\(id) has no settings")
      }
    }
    for section in LaunchConfigurationSection.allCases {
      #expect(!ConfigurationHelpTopic.settings(in: "launch.sections.\(section.id)").isEmpty)
    }
    for section in RepositorySetupSection.allCases {
      let id = "repository.sections.\(String(describing: section))"
      #expect(!ConfigurationHelpTopic.settings(in: id).isEmpty)
    }
    for id in ["app.sections.connections", "app.sections.appearance", "app.sections.notifications", "app.sections.logs", "app.sections.about", "providerAccount.sections.overview", "podsitter.sections.overview", "watcher.sections.overview", "deployment.sections.overview", "launch.sections.overview"] {
      #expect(!ConfigurationHelpTopic.settings(in: id).isEmpty)
    }
  }

  @Test func browserSearchDetailsAndBackNavigationDoNotChangeConfiguration() async throws {
    let fixture = try SettingsHelpFixture(.profile)
    let original = fixture.document.payload
    let host = fixture.host(.composition)
    defer { host.close() }
    try await host.wait { host.has("configuration-section-help-profile.sections.composition") }
    try host.press("configuration-section-help-profile.sections.composition")
    try await host.wait { settingNode("configuration-settings-browser") != nil }
    try editSettingsSearch("environmentId")
    try await host.wait { settingNode("configuration-topic-profile.environmentId") != nil }
    try settingPress("configuration-topic-profile.environmentId")
    try await host.wait { settingText("not a private copy") }
    try settingPress("configuration-settings-back")
    try await host.wait { settingNode("configuration-settings-search") != nil }
    try editSettingsSearch("no-such-setting")
    try await host.wait { settingText("No matching settings") }
    try editSettingsSearch("")
    try settingPress("configuration-settings-close")
    try await host.wait { settingNode("configuration-settings-browser") == nil }
    #expect(!host.enabled("configuration-editor-save"))
    #expect(fixture.document.payload == original)
    #expect(fixture.writes == 0)
  }

  @Test func choiceExplanationsAreCollapsedAndDoNotChangeSelections() async throws {
    let fixture = try SettingsHelpFixture(.profile)
    let host = fixture.host(.execution)
    defer { host.close() }
    try await host.wait { host.has("configuration-section-help-profile.sections.execution") }
    try host.press("configuration-section-help-profile.sections.execution")
    try await host.wait { settingNode("configuration-topic-profile.execution.target") != nil }
    try settingPress("configuration-topic-profile.execution.target")
    try await host.wait { settingNode("configuration-help-choices") != nil }
    try settingPress("configuration-help-choices")
    try await host.wait { settingText("Docker on the selected daemon host.") }
    try settingPress("configuration-help-close")
    #expect(fixture.document.payload["execution"] == nil)
    #expect(fixture.document.payload["futureField"] == .string("keep"))
    #expect(!host.enabled("configuration-editor-save"))
  }

  @Test func qualifiedHelpDoesNotGuessBetweenUnrelatedNameFields() {
    let section = "toolPack.sections.integrations"
    #expect(ConfigurationHelpTopic.field("name", section: section) == nil)
    #expect(ConfigurationHelpTopic.field("name", section: section, path: "skills[].name")?.id == "toolPack.skills.identity")
    #expect(ConfigurationHelpTopic.field("name", section: section, path: "mcpServers[].name")?.id == "toolPack.mcp.identity")
    #expect(ConfigurationHelpTopic.topic("launch.allocation.cpus").defaultBehavior.contains("replaces the Profile map"))
  }

  @Test func skillAndMcpNamesOpenTheirOwnExplanations() async throws {
    let fixture = try SettingsHelpFixture(.toolPack, payload: [
      "skills": .array([.object(["name": .string("sample-skill"), "source": .object(["type": .string("inline"), "content": .string("Sample procedure")])])]),
      "mcpServers": .array([.object(["name": .string("sample-server"), "transport": .object(["type": .string("http"), "url": .string("https://example.invalid/mcp")])])]),
    ])
    let original = fixture.document.payload
    let host = fixture.host(.integrations)
    defer { host.close() }
    for id in ["toolPack.skills.identity", "toolPack.mcp.identity"] {
      try await host.wait { host.has("configuration-help-\(id)") }
      try host.press("configuration-help-\(id)")
      try await host.wait { settingText(ConfigurationHelpTopic.topic(id).title) }
      try settingPress("configuration-help-close")
      try await host.wait { settingNode("configuration-help-details") == nil }
    }
    #expect(fixture.document.payload == original)
    #expect(fixture.writes == 0)
    #expect(!host.enabled("configuration-editor-save"))
  }

  @Test func allAreasOpenWithoutMaterializingDefaultsOrSaving() async throws {
    for kind in [ConfigurationKind.profile, .ai, .workflow, .environment, .githubAccess, .toolPack, .repository, .packageFeed] {
      let fixture = try SettingsHelpFixture(kind)
      let original = fixture.document.payload
      for area in ConfigurationEditorArea.areas(for: kind) {
        let host = fixture.host(area)
        if !area.hasDedicatedHelp(for: kind) {
          let id = "configuration-section-help-\(area.helpTopicID(for: kind))"
          try await host.wait { host.has(id) }
          try host.press(id)
          try await host.wait { settingNode("configuration-settings-browser") != nil }
          try settingPress("configuration-settings-close")
          try await host.wait { settingNode("configuration-settings-browser") == nil }
        }
        #expect(!host.enabled("configuration-editor-save"), "\(kind).\(area)")
        #expect(fixture.document.payload == original)
        #expect(fixture.writes == 0)
        host.close()
      }
    }
  }

  @Test(arguments: [680.0, 1400.0], [false, true])
  func representativeFormsWrapWithoutPermanentWallsOfText(width: Double, light: Bool) async throws {
    for (kind, area) in [(ConfigurationKind.profile, ConfigurationEditorArea.composition), (.ai, .main), (.workflow, .run), (.environment, .runtime), (.toolPack, .integrations), (.repository, .overview), (.githubAccess, .rules), (.packageFeed, .overview)] {
      let fixture = try SettingsHelpFixture(kind)
      let host = fixture.host(area, width: width, light: light)
      try await host.wait { host.has("configuration-section-help-\(area.helpTopicID(for: kind))") }
      #expect(host.hosting.fittingSize.width <= width)
      #expect(!host.containsText("When to use it"))
      try host.capture("settings-\(kind.rawValue)-\(Int(width))-\(light ? "light" : "dark")")
      host.close()
    }
  }
}

@MainActor private final class SettingsHelpFixture {
  var document: ConfigurationDocument
  var writes = 0
  init(_ kind: ConfigurationKind, payload: [String: ConfigurationJSON] = [:]) throws {
    let raw: ConfigurationJSON = .object([
      "id": .string("help-\(kind.rawValue)"), "kind": .string(kind.rawValue),
      "name": .string("Sample \(kind.rawValue) settings"), "revision": .number(1),
      "createdAt": .string("2026-11-13T00:00:00Z"), "updatedAt": .string("2026-11-13T00:00:00Z"),
      "archived": .bool(false), "payload": .object(payload.merging(["futureField": .string("keep")]) { _, new in new }),
    ])
    document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(raw.formatted().utf8))
  }
  func host(_ area: ConfigurationEditorArea, width: Double = 1120, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("Offline settings help fixture")
    let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, _ in self.writes += 1; return self.document },
      archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: document.kind, document: document, actions: actions, onClose: {}, initialArea: area), width: width, light: light)
  }
}

@MainActor private func settingAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }; return node.value(forKey: key)
}
@MainActor private func settingNodes(_ root: NSObject) -> [NSObject] {
  [root] + (settingAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(settingNodes)
}
@MainActor private var allSettingNodes: [NSObject] { NSApplication.shared.windows.compactMap(\.contentView).flatMap(settingNodes) }
@MainActor private func settingNode(_ id: String) -> NSObject? {
  allSettingNodes.first { settingAX($0, "accessibilityIdentifier") as? String == id }
}
@MainActor private func settingText(_ text: String) -> Bool {
  allSettingNodes.contains { (settingAX($0, "accessibilityLabel") as? String ?? "").contains(text)
    || (settingAX($0, "accessibilityValue") as? String ?? "").contains(text) }
}
@MainActor private func settingPress(_ id: String) throws {
  let node = try #require(allSettingNodes.first { settingAX($0, "accessibilityIdentifier") as? String == id && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
  _ = settingAX(node, "accessibilityPerformPress")
}
@MainActor private func editSettingsSearch(_ text: String) throws {
  func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
  let field = try #require(NSApplication.shared.windows.compactMap(\.contentView).flatMap(descendants).compactMap { $0 as? NSTextField }.first { $0.placeholderString == "Find a setting or JSON path" })
  field.window?.makeFirstResponder(field)
  let editor = try #require(field.currentEditor() as? NSTextView)
  editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
  field.window?.makeFirstResponder(nil)
}
