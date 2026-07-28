import Testing
import Foundation
import AutopodClient
import SwiftUI
@testable import AutopodUI

private final class EffortBox: @unchecked Sendable {
    var value: ReasoningEffort?

    init(_ value: ReasoningEffort?) {
        self.value = value
    }

    var binding: Binding<ReasoningEffort?> {
        Binding(get: { self.value }, set: { self.value = $0 })
    }
}

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
    let stored = EffortBox(.auto)
    let picker = ReasoningEffortField.binding(value: stored.binding)

    picker.wrappedValue = .xhigh

    #expect(stored.value == .xhigh)
}

@Test func derivedReasoningEffortStaysInheritedUntilOverrideIsActivated() {
    let draft = Profile(
        name: "child",
        repoUrl: "https://example.com/repo.git",
        reasoningEffort: nil
    )
    let stored = EffortBox(draft.reasoningEffort)
    let inheritedPicker = ReasoningEffortField.binding(value: stored.binding, fallback: .high)

    #expect(inheritedPicker.wrappedValue == .high)
    #expect(stored.value == nil)

    ReasoningEffortField.activateOverride(value: stored.binding, parent: .high)

    #expect(stored.value == .high)
}

@Test func newDerivedProfileActivationUsesParentInsteadOfDraftAutoDefault() {
    let draft = Profile(
        name: "child",
        repoUrl: "https://example.com/repo.git",
        reasoningEffort: .auto
    )
    let stored = EffortBox(draft.reasoningEffort)

    ReasoningEffortField.activateOverride(value: stored.binding, parent: .high)

    #expect(stored.value == .high)
}

@Test func derivedReasoningEffortOverrideSelectionDoesNotMutateParent() {
    let parent = ReasoningEffort.medium
    let child = EffortBox(nil)

    ReasoningEffortField.activateOverride(value: child.binding, parent: parent)
    let picker = ReasoningEffortField.binding(value: child.binding, fallback: parent)
    picker.wrappedValue = .low

    #expect(parent == .medium)
    #expect(child.value == .low)
}
