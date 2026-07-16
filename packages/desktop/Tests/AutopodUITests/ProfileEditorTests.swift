import Testing
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
