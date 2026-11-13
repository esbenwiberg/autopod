import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationValidationHelpTests {
  @Test func allPhasesHaveAccurateOwnersAndHelp() {
    #expect(ConfigurationValidationPhase.allCases.map(\.rawValue) == ["setup", "lint", "sast", "build", "test", "health", "pages", "facts", "review", "advisory"])
    let topics = ConfigurationHelpTopic.all.filter { $0.id.hasPrefix("workflow.validation") }
    #expect(topics.count == 12)
    for phase in ConfigurationValidationPhase.allCases {
      #expect(phase.topic.source != nil)
      #expect(phase.topic.summary.count < 110)
    }
    #expect(ConfigurationValidationPhase.facts.sourceKinds.isEmpty)
    #expect(ConfigurationValidationPhase.review.sourceKinds == [.ai])
    #expect(ConfigurationValidationPhase.advisory.sourceKinds == [.repository, .ai])
    #expect(ConfigurationValidationPhase.pages.topic.behavior.contains("only after Health passes"))
    #expect(ConfigurationValidationPhase.facts.topic.behavior.contains("does not generate facts"))
    #expect(ConfigurationValidationPhase.advisory.topic.behavior.contains("checklist"))
  }

  @Test func editingOnlyOnePhasePreservesOthersUnknownFieldsAndAdvisoryPair() {
    var payload: [String: ConfigurationJSON] = [
      "validationPhases": .array([.string("review"), .string("future-phase"), .string("test")]),
      "futureField": .object(["retained": .bool(true)]),
    ]
    let original = payload
    for phase in ConfigurationValidationPhase.allCases { _ = phase.isEnabled(payload) }
    #expect(payload == original)
    ConfigurationValidationPhase.build.setEnabled(true, in: &payload)
    #expect(payload["validationPhases"] == .array([.string("review"), .string("future-phase"), .string("test"), .string("build")]))
    ConfigurationValidationPhase.build.setEnabled(false, in: &payload)
    #expect(payload == original)
    ConfigurationValidationPhase.advisory.setEnabled(true, in: &payload)
    #expect(payload["advisoryBrowserQaEnabled"] == .bool(true))
    #expect(payload["validationPhases"]?.array?.last == .string("advisory"))
    #expect(payload["futureField"] == original["futureField"])
  }

  @Test func everyInfoPopoverExplainsSourcesWithoutDirtyingMissingFields() async throws {
    let fixture = try ValidationHelpFixture()
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("configuration-help-workflow.validation.setup") }
    for phase in ConfigurationValidationPhase.allCases {
      try host.press("configuration-help-\(phase.topic.id)")
      try await host.wait { validationNode("configuration-help-details") != nil }
      #expect(validationText(try #require(phase.topic.source)))
      #expect(!validationText(phase.topic.example))
      try validationPress("configuration-help-example")
      try await host.wait { validationText(phase.topic.example) }
      try validationPress("configuration-help-close")
      try await host.wait { validationNode("configuration-help-details") == nil }
      #expect(!host.enabled("configuration-editor-save"))
    }
    #expect(fixture.document.payload == original)
    #expect(fixture.document.payload["maxValidationAttempts"] == nil)
    #expect(fixture.document.payload["advisoryBrowserQaEnabled"] == nil)
    #expect(fixture.writes.isEmpty)
  }

  @Test func nativeTogglesAttemptsSaveReopenAndRetainFutureValues() async throws {
    let fixture = try ValidationHelpFixture()
    fixture.document.payload["validationPhases"] = .array([.string("future-phase")])
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("workflow-validation-build") }
    for phase in ConfigurationValidationPhase.allCases { try host.press(phase.toggleID) }
    try host.press("configuration-editor-save")
    try await host.wait { fixture.writes.count == 1 }
    #expect(fixture.document.payload["validationPhases"]?.array == [.string("future-phase")] + ConfigurationValidationPhase.allCases.map { .string($0.rawValue) })
    #expect(fixture.document.payload["advisoryBrowserQaEnabled"] == .bool(true))
    #expect(fixture.document.payload["maxValidationAttempts"] == nil)
    #expect(fixture.document.payload["futureField"] == .bool(true))
    let reopened = fixture.host()
    defer { reopened.close() }
    try await reopened.wait { reopened.containsText("Validation attempts: 3") }
    #expect(!reopened.enabled("configuration-editor-save"))
    try reopened.press("workflow-validation-facts")
    try reopened.press("configuration-editor-save")
    try await reopened.wait { fixture.writes.count == 2 }
    #expect(fixture.document.payload["validationPhases"]?.array?.contains(.string("facts")) == false)
    #expect(fixture.document.payload["validationPhases"]?.array?.contains(.string("future-phase")) == true)
    #expect(fixture.document.payload["advisoryBrowserQaEnabled"] == .bool(true))
  }

  @Test func sourceChoosersAreExplicitAndNavigateWithoutSaving() async throws {
    let fixture = try ValidationHelpFixture()
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("workflow-validation-source-build") }
    for (phase, id) in [("build", "repository"), ("review", "ai")] {
      try host.press("workflow-validation-source-\(phase)")
      try await host.wait { validationNode("validation-source-chooser") != nil }
      #expect(validationText("The launch selects the actual"))
      #expect(validationNode("validation-source-open-archived") == nil)
      try validationPress("validation-source-open-\(id)")
      try await host.wait { fixture.opened.count == (phase == "build" ? 1 : 2) }
      #expect(fixture.opened.last?.id == id)
      try await host.wait { validationNode("validation-source-chooser") == nil }
    }
    #expect(fixture.document.payload == original)
    #expect(fixture.writes.isEmpty)
    #expect(!host.enabled("configuration-editor-save"))
  }

  @Test func sourceNavigationRetainsExistingDiscardGuard() async throws {
    let fixture = try ValidationHelpFixture()
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("workflow-validation-build") }
    try host.press("workflow-validation-build")
    try host.press("workflow-validation-source-build")
    try await host.wait { validationNode("validation-source-open-repository") != nil }
    try validationPress("validation-source-open-repository")
    try await host.wait { validationNode("configuration-editor-keep-editing") != nil }
    #expect(fixture.opened.isEmpty)
    try validationPress("configuration-editor-keep-editing")
    try await host.wait { validationNode("configuration-editor-keep-editing") == nil }
    #expect(host.enabled("configuration-editor-save"))
    try host.press("workflow-validation-source-build")
    try await host.wait { validationNode("validation-source-open-repository") != nil }
    try validationPress("validation-source-open-repository")
    try await host.wait { validationNode("configuration-editor-discard") != nil }
    try validationPress("configuration-editor-discard")
    try await host.wait { fixture.opened.count == 1 }
    #expect(fixture.document.payload == original)
    #expect(fixture.writes.isEmpty)
  }

  @Test func emptySourceChooserExplainsMissingContextWithoutChangingAnything() async throws {
    let fixture = try ValidationHelpFixture()
    fixture.sources = []
    let original = fixture.document.payload
    let host = fixture.host()
    defer { host.close() }
    try await host.wait { host.has("workflow-validation-source-build") }
    try host.press("workflow-validation-source-build")
    try await host.wait { validationText("No repositories available") }
    try validationPress("validation-source-close")
    #expect(fixture.document.payload == original)
    #expect(fixture.opened.isEmpty)
    #expect(!host.enabled("configuration-editor-save"))
  }

  @Test(arguments: [680.0, 900.0, 1400.0], [false, true])
  func nativeValidationLayoutsRemainCompactAndWrap(width: Double, light: Bool) async throws {
    let fixture = try ValidationHelpFixture()
    fixture.document.payload["validationPhases"] = .array(["setup", "lint", "sast", "build", "test", "facts", "review"].map(ConfigurationJSON.string))
    let host = fixture.host(width: width, light: light)
    defer { host.close() }
    try await host.wait { host.has("workflow-validation-setup") }
    #expect(host.hosting.fittingSize.width <= width)
    #expect(!host.containsText("When to use it"))
    #expect(!host.enabled("configuration-editor-save"))
    try host.capture("validation-\(Int(width))-\(light ? "light" : "dark")")
  }
}

@MainActor private final class ValidationHelpFixture {
  var document: ConfigurationDocument
  var sources: [ConfigurationDocument]
  var writes: [ConfigurationWriteRequest] = []
  var opened: [ConfigurationDocument] = []
  init() throws {
    func doc(_ id: String, _ kind: String, _ name: String, _ payload: [String: ConfigurationJSON], archived: Bool = false) throws -> ConfigurationDocument {
      let raw: ConfigurationJSON = .object([
        "id": .string(id), "kind": .string(kind), "name": .string(name), "revision": .number(1),
        "createdAt": .string("2026-11-13T00:00:00Z"), "updatedAt": .string("2026-11-13T00:00:00Z"),
        "archived": .bool(archived), "payload": .object(payload),
      ])
      return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(raw.formatted().utf8))
    }
    document = try doc("workflow", "workflow", "Build, test & approval", ["futureField": .bool(true)])
    sources = [
      try doc("repository", "repository", "Example repository", ["setups": .array([.object(["id": .string("development"), "name": .string("Development"), "buildCommand": .string("npm run build")])])]),
      try doc("ai", "ai", "Careful review", ["reviewer": .object(["mode": .string("follow-main")])]),
      try doc("archived", "repository", "Archived repository", [:], archived: true),
    ]
  }
  func host(width: Double = 1400, light: Bool = false) -> LaunchComposerHost {
    let unavailable = DaemonError.badRequest("Offline Validation help test")
    let actions = LaunchConfigurationActions(documents: [document] + sources, capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable }, save: { _, request in
        #expect(request.expectedRevision == self.document.revision)
        self.writes.append(request); self.document.payload = request.payload; self.document.revision += 1
        return self.document
      }, archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    return LaunchComposerHost(ConfigurationEditorSheet(kind: .workflow, document: document, actions: actions,
      onClose: {}, onOpenValidationSource: { self.opened.append($0) }, initialArea: .validation), width: width, light: light)
  }
}

@MainActor private func validationAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func validationNodes(_ root: NSObject) -> [NSObject] {
  [root] + (validationAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(validationNodes)
}
@MainActor private var validationAllNodes: [NSObject] {
  NSApplication.shared.windows.compactMap(\.contentView).flatMap(validationNodes)
}
@MainActor private func validationNode(_ id: String) -> NSObject? {
  validationAllNodes.first { validationAX($0, "accessibilityIdentifier") as? String == id }
}
@MainActor private func validationText(_ text: String) -> Bool {
  validationAllNodes.contains { (validationAX($0, "accessibilityLabel") as? String ?? "").contains(text)
    || (validationAX($0, "accessibilityValue") as? String ?? "").contains(text) }
}
@MainActor private func validationPress(_ id: String) throws {
  let node = try #require(validationAllNodes.first { validationAX($0, "accessibilityIdentifier") as? String == id
    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
  _ = validationAX(node, "accessibilityPerformPress")
}
