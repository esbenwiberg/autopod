import Testing
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
