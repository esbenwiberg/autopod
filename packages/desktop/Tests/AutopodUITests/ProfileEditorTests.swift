import Testing
import Foundation
import AutopodClient
@testable import AutopodUI

@Test func profileEditorUsesDaemonGitHubAuthAndKeepsAdoPatManagement() {
    let credentialKeys = ProfileOverrideCatalog.all
        .filter { $0.section == .credentials }
        .map(\.key)

    #expect(!credentialKeys.contains("githubPat"))
    #expect(!credentialKeys.contains("githubPatExpiresAt"))
    #expect(credentialKeys.contains("adoPat"))
    #expect(credentialKeys.contains("adoPatExpiresAt"))
}

@Test func daemonGitHubAuthStatusRepresentsReadyAndUnavailableStates() throws {
    let ready = try JSONDecoder().decode(
        DaemonGitHubAuthStatusResponse.self,
        from: Data(#"{"available":true,"login":"autopod-dev","setup":"configure gh"}"#.utf8)
    )
    #expect(ready.available)
    #expect(ready.login == "autopod-dev")
    #expect(ready.reason == nil)

    let unavailable = try JSONDecoder().decode(
        DaemonGitHubAuthStatusResponse.self,
        from: Data(#"{"available":false,"reason":"authentication rejected","setup":"configure gh"}"#.utf8)
    )
    #expect(!unavailable.available)
    #expect(unavailable.login == nil)
    #expect(unavailable.reason == "authentication rejected")
}

@Test func baseProfileReasoningEffortSelectionPreservesPortableValue() {
    var profile = Profile(name: "base", repoUrl: "https://example.com/repo.git")

    profile.reasoningEffort = .xhigh

    #expect(profile.reasoningEffort == .xhigh)
}

@Test func derivedReasoningEffortStaysInheritedUntilOverrideIsActivated() {
    var profile = Profile(
        name: "child",
        repoUrl: "https://example.com/repo.git",
        reasoningEffort: nil
    )

    #expect(profile.reasoningEffort == nil)

    profile.reasoningEffort = ReasoningEffortField.activatedOverrideValue(
        current: profile.reasoningEffort,
        parent: .high
    )

    #expect(profile.reasoningEffort == .high)
}

@Test func derivedReasoningEffortOverrideSelectionDoesNotMutateParent() {
    let parent = ReasoningEffort.medium
    var child = Profile(
        name: "child",
        repoUrl: "https://example.com/repo.git",
        reasoningEffort: nil
    )

    child.reasoningEffort = ReasoningEffortField.activatedOverrideValue(
        current: child.reasoningEffort,
        parent: parent
    )
    child.reasoningEffort = .low

    #expect(parent == .medium)
    #expect(child.reasoningEffort == .low)
}
