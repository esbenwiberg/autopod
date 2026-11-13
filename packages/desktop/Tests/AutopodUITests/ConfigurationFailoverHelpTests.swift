import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationFailoverHelpTests {
  @Test func bundledTopicsAndRoleSemantics() {
    let failover = ConfigurationHelpTopic.all.filter { $0.id.hasPrefix("ai.failover") }
    #expect(failover.count == 9)
    #expect(Set(failover.map(\.id)).count == 9)
    #expect(ConfigurationFailoverRole.main.topic.behavior.contains("does not switch automatically for general outages"))
    #expect(ConfigurationFailoverRole.reviewer.topic.behavior.contains("when usage is measured"))
    #expect(ConfigurationFailoverRole.advisor.topic.behavior.contains("Workflow controls that"))
    #expect(ConfigurationHelpTopic.topic("ai.failover.switches").paths.contains("main.maxHops"))
  }

  @Test func offEmptyAndConfiguredStatesArePresentationOnly() {
    let samples: [([String: ConfigurationJSON], ConfigurationFailoverState)] = [
      ([:], .disabled),
      (["maxHops": .number(0), "failover": .array([.object(["model": .string("saved")])])], .disabled),
      (["maxHops": .number(2), "failover": .array([])], .noBackups),
      (["maxHops": .number(2)], .noBackups),
      (["maxHops": .number(1), "failover": .array([.object(["model": .string("saved")])])], .configured),
    ]
    for (sample, state) in samples {
      let original = sample
      #expect(ConfigurationFailoverState(route: sample) == state)
      #expect(sample == original)
    }
  }

  @Test func openingPopoverExampleAndPathsDoesNotDirtyOrSaveTheEditor() async throws {
    let fixture = try FailoverHelpFixture()
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("failover-main-about") }
    #expect(!host.enabled("configuration-editor-save"))
    #expect(!host.containsText("When to use it"))
    try host.press("failover-main-about")
    try await host.wait { helpNode("configuration-help-details") != nil }
    #expect(helpText("general outages"))
    #expect(!helpText("Your primary account reaches its confirmed usage limit."))
    try pressHelp("configuration-help-example")
    try await host.wait { helpText("Your primary account reaches its confirmed usage limit.") }
    try pressHelp("configuration-help-paths")
    try await host.wait { helpText("main.failover") }
    try pressHelp("configuration-help-close")
    try await host.wait { helpNode("configuration-help-details") == nil }
    #expect(!host.enabled("configuration-editor-save"))
    #expect(fixture.document.payload == original)
    #expect(fixture.writes.isEmpty)
  }

  @Test func followedRolesHaveHelpWithoutMaterializingAdvisorOrRoutes() async throws {
    let fixture = try FailoverHelpFixture()
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.containsText("Advisor: uses Reviewer's route and backups.") }
    #expect(host.containsText("Reviewer: uses Main agent's route and backups."))
    for role in ["reviewer", "advisor"] {
      try host.press("failover-\(role)-about")
      try await host.wait { helpNode("configuration-help-details") != nil }
      #expect(helpText(role == "reviewer" ? "when usage is measured" : "Workflow controls that"))
      try pressHelp("configuration-help-close")
      try await host.wait { helpNode("configuration-help-details") == nil }
    }
    #expect(fixture.document.payload == original)
    #expect(fixture.document.payload["advisor"] == nil)
    #expect(!host.enabled("configuration-editor-save"))
  }

  @Test func backupEditsSaveReopenAndPreserveUnknownDataAndZeroLimit() async throws {
    let fixture = try FailoverHelpFixture()
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("failover-main-status") }
    try host.pressLabel("Add")
    try await host.wait { host.containsText("Backup accounts & models") }
    try host.editField(placeholder: "Model", text: "backup-model")
    host.window.makeFirstResponder(nil)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["main"]?["maxHops"] == .number(0))
    #expect(fixture.document.payload["main"]?["futureRouteField"] == .string("retain"))
    #expect(fixture.document.payload["futureField"] == .bool(true))
    #expect(fixture.document.payload["advisor"] == nil)
    #expect(fixture.document.payload["main"]?["failover"]?.array?.first?["model"] == .string("backup-model"))
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.containsText("backup-model") }
    #expect(reopened.containsText("Saved backups stay inactive."))
    #expect(!reopened.enabled("configuration-editor-save"))
    for key in ["account", "runtime", "model", "effort"] {
      try reopened.press("configuration-help-ai.failover.\(key)")
      try await reopened.wait { helpText(ConfigurationHelpTopic.topic("ai.failover.\(key)").whenToUse) }
      try pressHelp("configuration-help-close")
      try await reopened.wait { helpNode("configuration-help-details") == nil }
      #expect(!reopened.enabled("configuration-editor-save"))
    }
  }

  @Test func detailsCloseByEscapeAndInfoHasAccessibleButtonRole() async throws {
    var closed = false
    let host = LaunchComposerHost(ConfigurationHelpDetails(topic: .topic("ai.failover"), close: { closed = true }), width: 440)
    defer { host.close() }
    try await host.wait { host.has("configuration-help-close") }
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: host.window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
    #expect(host.window.performKeyEquivalent(with: event))
    #expect(closed)
    // Info controls expose real native AX buttons, not hover-only text.
    let fixture = try FailoverHelpFixture()
    let editor = fixture.host()
    defer { editor.close() }
    try await editor.wait { editor.has("failover-main-about") }
    let button = try #require(editor.matches("failover-main-about").first)
    #expect(helpAX(button, "accessibilityRole") as? String == "AXButton")
    #expect(helpAX(button, "accessibilityLabel") as? String == "About Main agent failover")
  }

  @Test(arguments: [900.0, 1400.0], [false, true])
  func nativeLayoutsAndCollapsedDensity(width: Double, light: Bool) async throws {
    let fixture = try FailoverHelpFixture()
    var main = try #require(fixture.document.payload["main"]?.object)
    main["maxHops"] = .number(1)
    main["failover"] = .array([.object([
      "providerAccountId": .string("unavailable-account"), "runtime": .string("codex"),
      "model": .string("saved-backup"), "reasoningEffort": .string("auto"),
    ])])
    fixture.document.payload["main"] = .object(main)
    let host = fixture.host(width: width, light: light)
    defer { host.close() }
    try await host.wait { host.containsText("saved-backup") }
    #expect(host.hosting.fittingSize.width <= width)
    #expect(host.containsText("Saved account"))
    #expect(!host.containsText("When to use it"))
    #expect(!host.enabled("configuration-editor-save"))
    try host.capture("failover-\(Int(width))-\(light ? "light" : "dark")")
  }
}

@MainActor private final class FailoverHelpFixture {
  var document: ConfigurationDocument
  var writes: [ConfigurationWriteRequest] = []
  init() throws {
    let raw: ConfigurationJSON = .object([
      "id": .string("failover-help"), "kind": .string("ai"), "name": .string("Failover example"),
      "revision": .number(1), "createdAt": .string("2026-11-12T00:00:00Z"), "updatedAt": .string("2026-11-12T00:00:00Z"), "archived": .bool(false),
      "payload": .object([
        "main": .object(["providerAccountId": .string("primary"), "runtime": .string("codex"), "model": .string("primary-model"),
          "maxHops": .number(0), "failover": .array([]), "futureRouteField": .string("retain")]),
        "reviewer": .object(["mode": .string("follow-main")]), "futureField": .bool(true),
      ]),
    ])
    document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(raw.formatted().utf8))
  }
  func host(width: Double = 1120, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("Offline Failover fixture")
    let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
        #expect(request.expectedRevision == self.document.revision)
        self.writes.append(request); self.document.payload = request.payload; self.document.revision += 1
        return self.document
      }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .ai, document: document, actions: actions, onClose: {}, initialArea: .failover), width: width, light: light)
  }
}

@MainActor private func helpAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func helpNodes(_ root: NSObject) -> [NSObject] {
  [root] + (helpAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(helpNodes)
}
@MainActor private var allHelpNodes: [NSObject] {
  NSApplication.shared.windows.compactMap(\.contentView).flatMap(helpNodes)
}
@MainActor private func helpNode(_ id: String) -> NSObject? {
  allHelpNodes.first { helpAX($0, "accessibilityIdentifier") as? String == id }
}
@MainActor private func helpText(_ text: String) -> Bool {
  allHelpNodes.contains { (helpAX($0, "accessibilityLabel") as? String ?? "").contains(text)
    || (helpAX($0, "accessibilityValue") as? String ?? "").contains(text) }
}
@MainActor private func pressHelp(_ id: String) throws {
  let node = try #require(allHelpNodes.first { helpAX($0, "accessibilityIdentifier") as? String == id
    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
  _ = helpAX(node, "accessibilityPerformPress")
}
