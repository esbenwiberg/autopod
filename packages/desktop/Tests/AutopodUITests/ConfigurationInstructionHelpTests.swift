import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationInstructionHelpTests {
  @Test func topicsExplainMainAgentScopeOrderAndNonEnforcement() {
    let topics = ConfigurationHelpTopic.all.filter { $0.id.hasPrefix("toolPack.instructions") }
    #expect(topics.count == 3)
    #expect(ConfigurationHelpTopic.topic("toolPack.instructions").summary.contains("main agent"))
    #expect(ConfigurationHelpTopic.topic("toolPack.instructions").behavior.contains("without overwriting repository instruction files"))
    #expect(ConfigurationHelpTopic.topic("toolPack.instructions").impact.contains("does not install software, grant access or enforce a rule"))
    #expect(ConfigurationHelpTopic.topic("toolPack.instructions.heading").paths == ["instructions[].heading"])
    #expect(ConfigurationHelpTopic.topic("toolPack.instructions.content").defaultBehavior.contains("50,000"))
  }

  @Test(arguments: ["absent", "null", "empty"])
  func emptyHelpDoesNotMaterializeInstructionsOrDirtyThePack(state: String) async throws {
    let fixture = try InstructionHelpFixture()
    if state == "null" { fixture.document.payload["instructions"] = .null }
    if state == "empty" { fixture.document.payload["instructions"] = .array([]) }
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("tool-pack-instructions-empty") }
    try host.press("configuration-help-toolPack.instructions")
    try await host.wait { instructionNode("configuration-help-details") != nil }
    #expect(instructionText("Do not assume this text is copied into every Reviewer or Advisor prompt."))
    #expect(!instructionText(ConfigurationHelpTopic.topic("toolPack.instructions").example))
    try instructionPress("configuration-help-example")
    try await host.wait { instructionText(ConfigurationHelpTopic.topic("toolPack.instructions").example) }
    try instructionPress("configuration-help-close")
    try await host.wait { instructionNode("configuration-help-details") == nil }
    #expect(!host.enabled("configuration-editor-save"))
    #expect(fixture.document.payload == original)
    #expect(fixture.writes.isEmpty)
    try host.capture("instructions-empty-\(state)")
  }

  @Test func fieldPopoversPreservePopulatedSectionsAndUnknownData() async throws {
    let fixture = try InstructionHelpFixture()
    fixture.document.payload["instructions"] = .array([.object([
      "heading": .string("Project rules"), "content": .string("Read the repository guidance."),
      "futureSection": .object(["keep": .bool(true)]),
    ])])
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("tool-pack-instruction-content") }
    for key in ["heading", "content"] {
      let topic = ConfigurationHelpTopic.topic("toolPack.instructions.\(key)")
      try host.press("configuration-help-\(topic.id)")
      try await host.wait { instructionNode("configuration-help-details") != nil }
      #expect(instructionText(topic.defaultBehavior))
      try instructionPress("configuration-help-paths")
      try await host.wait { instructionText(topic.paths[0]) }
      try instructionPress("configuration-help-close")
      try await host.wait { instructionNode("configuration-help-details") == nil }
    }
    #expect(!host.enabled("configuration-editor-save"))
    #expect(fixture.document.payload == original)
    #expect(fixture.writes.isEmpty)
  }

  @Test func addsHeadingAndMultilineGuidanceSavesReopensAndRetainsPackData() async throws {
    let fixture = try InstructionHelpFixture()
    let unrelated = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("tool-pack-instructions-empty") }
    try host.pressLabel("Add")
    try await host.wait { host.has("tool-pack-instruction-heading") }
    try host.editField(placeholder: "Heading", text: "Design source of truth")
    host.window.makeFirstResponder(nil)
    let content = "Use supplied design references.\n\nReport what you actually inspected."
    try editInstructionText(host, text: content)
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["instructions"] == .array([.object([
      "heading": .string("Design source of truth"), "content": .string(content),
    ])]))
    for (key, value) in unrelated { #expect(fixture.document.payload[key] == value) }
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.containsText("Design source of truth") }
    #expect(reopened.containsText("Report what you actually inspected."))
    #expect(!reopened.enabled("configuration-editor-save"))
  }

  @Test func reorderRemoveAndClearUseExistingSavedOrderWithoutDroppingUnknownRowData() async throws {
    let fixture = try InstructionHelpFixture()
    let first: ConfigurationJSON = .object(["heading": .string("First"), "content": .string("First guidance"), "futureSection": .number(42)])
    let second: ConfigurationJSON = .object(["heading": .string("Second"), "content": .string("Second guidance")])
    fixture.document.payload["instructions"] = .array([first, second])
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("tool-pack-instruction-heading") }
    let move = try #require(host.nodes.first {
      instructionAX($0, "accessibilityLabel") as? String == "Move up"
        && instructionAX($0, "accessibilityEnabled") as? Bool == true
        && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
    })
    _ = instructionAX(move, "accessibilityPerformPress")
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["instructions"] == .array([second, first]))
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.has("tool-pack-instruction-heading") }
    try reopened.pressLabel("Remove")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.document.payload["instructions"] == .array([first]))
    let clear = fixture.host()
    defer { clear.close() }
    try await clear.wait { clear.has("tool-pack-instruction-heading") }
    try clear.pressLabel("Remove")
    try await clear.wait { clear.has("tool-pack-instructions-empty") }
    try clear.press("configuration-editor-save")
    try await clear.wait { fixture.writes.count == 3 }
    #expect(fixture.document.payload["instructions"] == .array([]))
    #expect(fixture.document.payload["futurePack"] == .bool(true))
  }

  @Test(arguments: [680.0, 900.0, 1400.0], [false, true])
  func nativeInstructionLayoutsWrapAndKeepDetailsCollapsed(width: Double, light: Bool) async throws {
    let fixture = try InstructionHelpFixture()
    fixture.document.payload["instructions"] = .array([.object([
      "heading": .string("Design source of truth"),
      "content": .string("Read repository guidance before editing.\nUse the supplied design references.\nReport any checks or comparisons you could not perform."),
    ])])
    let host = fixture.host(width: width, light: light)
    defer { host.close() }
    try await host.wait { host.has("tool-pack-instruction-content") }
    #expect(host.hosting.fittingSize.width <= width)
    #expect(host.containsText("main agent"))
    #expect(!host.containsText("When to use it"))
    #expect(!host.enabled("configuration-editor-save"))
    try host.capture("instructions-\(Int(width))-\(light ? "light" : "dark")")
  }
}

@MainActor private final class InstructionHelpFixture {
  var document: ConfigurationDocument
  var writes: [ConfigurationWriteRequest] = []
  init() throws {
    let raw: ConfigurationJSON = .object([
      "id": .string("instruction-pack"), "kind": .string("toolPack"), "name": .string("Engineering essentials"),
      "revision": .number(1), "createdAt": .string("2026-11-13T00:00:00Z"), "updatedAt": .string("2026-11-13T00:00:00Z"),
      "archived": .bool(false), "payload": .object([
        "skills": .array([]), "mcpServers": .array([]), "clis": .array([]),
        "requiredCapabilities": .array([.string("node")]), "futurePack": .bool(true),
      ]),
    ])
    document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(raw.formatted().utf8))
  }
  func host(width: Double = 1120, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("Offline instruction-help fixture")
    let actions = LaunchConfigurationActions(documents: [document], capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
        #expect(request.expectedRevision == self.document.revision)
        self.writes.append(request); self.document.payload = request.payload; self.document.revision += 1
        return self.document
      }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .toolPack, document: document, actions: actions, onClose: {}, initialArea: .instructions), width: width, light: light)
  }
}

@MainActor private func editInstructionText(_ host: LaunchComposerHost, text: String) throws {
  func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
  let editor = try #require(descendants(host.hosting).compactMap { $0 as? NSTextView }.first { $0.isEditable && !$0.isFieldEditor })
  host.window.makeFirstResponder(editor)
  editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
  host.window.makeFirstResponder(nil)
}
@MainActor private func instructionAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) || node.responds(to: NSSelectorFromString("is" + key.prefix(1).uppercased() + key.dropFirst())) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func instructionNodes(_ root: NSObject) -> [NSObject] {
  [root] + (instructionAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(instructionNodes)
}
@MainActor private var instructionAllNodes: [NSObject] {
  NSApplication.shared.windows.compactMap(\.contentView).flatMap(instructionNodes)
}
@MainActor private func instructionNode(_ id: String) -> NSObject? {
  instructionAllNodes.first { instructionAX($0, "accessibilityIdentifier") as? String == id }
}
@MainActor private func instructionText(_ text: String) -> Bool {
  instructionAllNodes.contains { (instructionAX($0, "accessibilityLabel") as? String ?? "").contains(text)
    || (instructionAX($0, "accessibilityValue") as? String ?? "").contains(text) }
}
@MainActor private func instructionPress(_ id: String) throws {
  let node = try #require(instructionAllNodes.first { instructionAX($0, "accessibilityIdentifier") as? String == id
    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
  _ = instructionAX(node, "accessibilityPerformPress")
}
