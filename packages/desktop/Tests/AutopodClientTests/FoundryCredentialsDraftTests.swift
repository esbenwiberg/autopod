import Foundation
import Testing
@testable import AutopodClient

@Test func foundryDraftBuildsTrimmedAnthropicPayload() throws {
  let draft = FoundryCredentialsDraft(
    endpoint: "  https://res.services.ai.azure.com/anthropic \n",
    apiKey: "  foundry-key\n",
    apiVersion: "ignored-on-anthropic"
  )

  #expect(try draft.payload() == [
    "provider": "foundry",
    "endpoint": "https://res.services.ai.azure.com/anthropic",
    "apiKey": "foundry-key",
    "apiSurface": "anthropic",
  ])
  #expect(draft.isComplete)
}

@Test func foundryDraftIncludesApiVersionOnlyForOpenAISurface() throws {
  let draft = FoundryCredentialsDraft(
    endpoint: "https://res.openai.azure.com",
    apiKey: "k",
    surface: .openai,
    apiVersion: " 2024-12-01-preview "
  )

  #expect(try draft.payload()["apiVersion"] == "2024-12-01-preview")
  #expect(try draft.payload()["apiSurface"] == "openai")
}

@Test(arguments: [
  ("", "k"),
  ("res.services.ai.azure.com", "k"),
  ("http://res.services.ai.azure.com", "k"),
  ("https://", "k"),
  ("https://res.services.ai.azure.com", "   "),
])
func foundryDraftRejectsIncompleteInput(endpoint: String, apiKey: String) {
  let draft = FoundryCredentialsDraft(endpoint: endpoint, apiKey: apiKey)

  #expect(!draft.isComplete)
  #expect(throws: DaemonError.self) { try draft.payload() }
}
