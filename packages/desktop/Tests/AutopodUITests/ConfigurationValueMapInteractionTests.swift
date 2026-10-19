import AppKit
import AutopodClient
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ConfigurationValueMapInteractionTests {
  @Test(arguments: ["deployment", "http", "stdio"]) func emptyConsumerMapsAcceptLiteralEntriesAndKeepTheirOtherFields(consumer: String) async throws {
    let state = ValueMapState()
    if consumer == "deployment" {
      state.fields = ["enabled": .bool(true), "source": .string("published-default"), "env": .object([:]), "targetId": .string("sample-target")]
    } else {
      state.fields = ["name": .string("sample-mcp"), "transport": .object(consumer == "http"
        ? ["type": .string("http"), "url": .string("https://mcp.example.com"), "headers": .object([:])]
        : ["type": .string("stdio"), "command": .string("sample-server"), "args": .array([.string("--stdio")]), "env": .object([:])])]
    }
    let binding = Binding(get: { state.fields }, set: { state.fields = $0 })
    let view = Group {
      if consumer == "deployment" { RepositoryDeploymentEditor(fields: binding) }
      else { McpTransportEditor(fields: binding) }
    }.padding(24).tint(DesktopTheme.accent)
    let host = LaunchComposerHost(view, width: 900)
    defer { host.close() }
    let prefix = consumer == "deployment" ? "deployment-env" : "mcp-values"
    try await host.wait { host.has("\(prefix)-name") }
    try host.editField(placeholder: "Entry name", text: "SAMPLE_MODE")
    host.window.makeFirstResponder(nil)
    try host.press("\(prefix)-add")
    try await host.wait { host.has("\(prefix)-value-SAMPLE_MODE") }
    try host.editField(placeholder: "Value for SAMPLE_MODE", text: "review")
    host.window.makeFirstResponder(nil)
    let value = consumer == "deployment" ? state.fields["env"]?["SAMPLE_MODE"] : state.fields["transport"]?[consumer == "http" ? "headers" : "env"]?["SAMPLE_MODE"]
    #expect(value == .object(["value": .string("review")]))
    if consumer == "deployment" { #expect(state.fields["targetId"] == .string("sample-target")) }
    else { #expect(state.fields["transport"]?["type"] == .string(consumer)) }
    try host.capture("value-map-\(consumer)")
    try host.press("\(prefix)-remove-SAMPLE_MODE")
    #expect(consumer == "deployment" ? state.fields["env"] == .object([:]) : state.fields["transport"]?[consumer == "http" ? "headers" : "env"] == .object([:]))
  }

  @Test func unsupportedSavedMapEntryStaysVisibleAndSkillDescriptionIsOptional() async throws {
    let state = ValueMapState()
    state.fields = ["FUTURE": .object(["futureReference": .string("keep")])]
    let binding = Binding(get: { state.fields }, set: { state.fields = $0 })
    let map = LaunchComposerHost(ConfigurationValueMapEditor(title: "Test values", context: "Fictional fixture", id: "test-map", values: binding).padding(24), width: 900)
    defer { map.close() }
    try await map.wait { map.has("test-map-remove-FUTURE") }
    #expect(map.containsText("Unsupported saved entry"))
    #expect(state.fields["FUTURE"] == .object(["futureReference": .string("keep")]))
    state.fields = ["name": .string("sample-skill"), "source": .object(["type": .string("builtin")])]
    let skill = LaunchComposerHost(SkillSourceEditor(fields: binding, repositories: []).padding(24), width: 900)
    defer { skill.close() }
    try await skill.wait { skill.has("configuration-skill-description") }
    try skill.editField(placeholder: "Skill description (optional)", text: "Read repository guidance")
    skill.window.makeFirstResponder(nil)
    #expect(state.fields["description"] == .string("Read repository guidance"))
    try skill.editField(placeholder: "Skill description (optional)", text: "")
    skill.window.makeFirstResponder(nil)
    #expect(state.fields["description"] == nil)
    #expect(state.fields["source"] == .object(["type": .string("builtin")]))
  }
}

@Observable @MainActor private final class ValueMapState {
  var fields: [String: ConfigurationJSON] = [:]
}
