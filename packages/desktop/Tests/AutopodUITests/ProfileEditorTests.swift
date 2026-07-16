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
