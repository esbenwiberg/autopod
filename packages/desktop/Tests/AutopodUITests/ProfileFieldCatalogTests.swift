import Testing
import AutopodClient
@testable import AutopodUI

@Test func profileOverrideCatalogContainsValidationSetupCommand() throws {
  let setup = ProfileOverrideCatalog.all.first { $0.key == "validationSetupCommand" }
  let buildRunKeys = ProfileOverrideCatalog.all
    .filter { $0.section == .buildRun }
    .map(\.key)
  let setupIndex = try #require(buildRunKeys.firstIndex(of: "validationSetupCommand"))
  let testIndex = try #require(buildRunKeys.firstIndex(of: "testCommand"))

  #expect(setup?.label == "Validation Setup")
  #expect(setupIndex < testIndex)
}

@Test func profileOverrideCatalogLabelsSharedBuildTimeoutAsBuildAndSetup() {
  let timeout = ProfileOverrideCatalog.all.first { $0.key == "buildTimeout" }

  #expect(timeout?.label == "Build + Setup")
}

@Test func profileOverrideCatalogPlacesReasoningEffortBetweenModelsAndRuntime() throws {
  let agentFields = ProfileOverrideCatalog.all.filter { $0.section == .agent }
  let keys = agentFields.map(\.key)
  let effort = try #require(agentFields.first { $0.key == "reasoningEffort" })
  let reviewerIndex = try #require(keys.firstIndex(of: "reviewerModel"))
  let effortIndex = try #require(keys.firstIndex(of: "reasoningEffort"))
  let runtimeIndex = try #require(keys.firstIndex(of: "defaultRuntime"))

  #expect(effort.label == "Reasoning effort")
  #expect(effort.help == ReasoningEffortField.help)
  #expect(reviewerIndex < effortIndex)
  #expect(effortIndex < runtimeIndex)
}

@Test func reasoningEffortPickerUsesExactPortableWireValuesAndLabels() {
  let valuesAndLabels = ReasoningEffortField.options.map { ($0.value.rawValue, $0.label) }

  #expect(valuesAndLabels.map(\.0) == ["auto", "low", "medium", "high", "xhigh"])
  #expect(
    valuesAndLabels.map(\.1)
      == ["Auto (runtime default)", "Low", "Medium", "High", "Extra high"]
  )
}

@Test func reasoningEffortHelpExplainsQualityLatencyAndTokenTradeoff() {
  #expect(
    ReasoningEffortField.help
      == "Higher effort can improve difficult work while increasing latency and token use."
  )
}
