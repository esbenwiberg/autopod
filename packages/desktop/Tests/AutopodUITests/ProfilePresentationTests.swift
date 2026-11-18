import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ProfilePresentationTests {
  private let profileID = "76f0c4b8-0000-4000-8000-0fe13ce164f7"

  private func document(id: String, name: String) throws -> ConfigurationDocument {
    let json = ConfigurationJSON.object([
      "id": .string(id), "kind": .string("profile"), "name": .string(name), "revision": .number(1),
      "createdAt": .string("2026-11-18T00:00:00Z"), "updatedAt": .string("2026-11-18T00:00:00Z"),
      "archived": .bool(false), "payload": .object([:]),
    ])
    return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(json.formatted().utf8))
  }
  private func actions() throws -> LaunchConfigurationActions {
    let unavailable = DaemonError.badRequest("No daemon in profile presentation test")
    return LaunchConfigurationActions(documents: [try document(id: profileID, name: "Works Claude"),
      try document(id: "codex-profile", name: "Works Codex")], capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
      save: { _, _ in throw unavailable }, archive: { _ in throw unavailable },
      discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  }
  private func pod(state: String = "active") -> Pod {
    var pod = DesktopPerformanceFixtures.pods[0]
    pod.profileName = profileID
    pod.profileDisplay = .init(id: profileID, name: "Works Claude", state: state)
    return pod
  }

  @Test func searchMatchesNameFullOrPartialIDWithoutDroppingOtherSearchFields() throws {
    let profile = try document(id: profileID, name: "Works Claude")
    for query in ["", "works claude", profileID, "76F0C4B8", "  76f0c4b8  ", "backend"] {
      #expect(ProfileLibrarySearch.matches(profile, query: query, details: ["Backend service"]))
    }
    #expect(!ProfileLibrarySearch.matches(profile, query: "not-present"))
  }

  @Test func historyGroupsKeepDistinctIDsWhenCapturedLabelsAreReused() {
    var first = pod(), second = DesktopPerformanceFixtures.pods[1]
    second.profileName = "second-profile"
    second.profileDisplay = .init(id: "second-profile", name: "Works Claude", state: "active")
    first.pod = .init(agentMode: .auto, output: .pr, validate: true, promotable: false)
    second.pod = first.pod
    let history = HistoryView(pods: [first, second], actions: .preview, profileNames: [])
    #expect(Set(history.profileHistoryStats.map(\.id)) == [profileID, "second-profile"])
    #expect(history.profileHistoryStats.map(\.name) == ["Works Claude", "Works Claude"])
  }

  @Test func classicOverviewDoesNotOfferAnUnsupportedWorkspaceLink() async throws {
    let host = LaunchComposerHost(OverviewTab(pod: pod(), events: [])
      .environment(\.desktopOpenProfile, { _ in Issue.record("Unsupported classic navigation") }), width: 1100, redesign: false)
    defer { host.close() }
    try await host.wait { host.containsText("Works Claude") }
    #expect(!host.has("pod-open-profile"))
  }

  @Test func nativeProfilesSearchFindsThePodIDAndTheReadableName() async throws {
    let host = LaunchComposerHost(ConfigurationLibraryView(actions: try actions()), width: 1100)
    defer { host.close() }
    try await host.wait { host.containsText("Works Claude") && host.containsText("Works Codex") }
    try host.editField(placeholder: "Search profiles", text: "76f0c4b8")
    try await host.wait { host.containsText("Works Claude") && !host.containsText("Works Codex") }
    try host.editField(placeholder: "Search profiles", text: "not-present")
    try await host.wait { host.containsText("No profiles found") }
    try host.editField(placeholder: "Search profiles", text: "Works Claude")
    try await host.wait { host.containsText("Works Claude") && !host.containsText("No profiles found") }
  }

  @Test func openingAProfilePrioritizesItsIDOverAnotherProfilesName() async throws {
    var configuration = try actions()
    configuration.documents.append(try document(id: "decoy", name: profileID))
    var requested: String? = profileID
    let host = LaunchComposerHost(ConfigurationLibraryView(actions: configuration,
      profileToOpen: Binding(get: { requested }, set: { requested = $0 })), width: 1100)
    defer { host.close() }
    try await host.wait { host.has("configuration-editor-save") }
    #expect(requested == nil)
    #expect(host.containsText("Works Claude"))
  }

  @Test func sidebarDisplaysTheNameButSelectsTheStableIdentity() async throws {
    var selected: SidebarItem = .active
    let host = LaunchComposerHost(SidebarView(pods: [pod()], selection: Binding(get: { selected }, set: { selected = $0 }),
      showCreateSheet: .constant(false)), width: 300)
    defer { host.close() }
    try await host.wait { host.containsText("Filter by profile") }
    try host.pressLabel("Filter by profile")
    try await host.wait { host.has("profile-filter-\(profileID)") }
    #expect(host.containsText("Works Claude"))
    try host.press("profile-filter-\(profileID)")
    #expect(selected == .profile(profileID))
  }

  @Test func overviewShowsTheNameAndOpensByIDNotName() async throws {
    var opened: String?
    let host = LaunchComposerHost(OverviewTab(pod: pod(), events: [])
      .environment(\.desktopOpenProfile, { opened = $0 }), width: 1100)
    defer { host.close() }
    try await host.wait { host.has("pod-open-profile") }
    #expect(host.containsText("Works Claude"))
    try host.press("pod-open-profile")
    #expect(opened == profileID)
  }

  @Test(arguments: ["archived", "deleted", "unavailable"])
  func unavailableProfilesDoNotOfferAnEditLink(state: String) async throws {
    var pod = pod(state: state)
    if state == "unavailable" { pod.profileDisplay = .init(id: profileID, state: state) }
    let host = LaunchComposerHost(OverviewTab(pod: pod, events: [])
      .environment(\.desktopOpenProfile, { _ in Issue.record("Unavailable profile was opened") }), width: 1100)
    defer { host.close() }
    let label = state == "unavailable" ? "Unavailable profile" : "Works Claude (\(state))"
    try await host.wait { host.containsText(label) }
    #expect(!host.has("pod-open-profile"))
    #expect(pod.profileName == profileID)
  }
}
