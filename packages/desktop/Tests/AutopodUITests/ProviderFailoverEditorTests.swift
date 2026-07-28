import Foundation
import Testing
import AutopodClient
@testable import AutopodUI

private func failoverAccount(
    id: String,
    provider: String,
    authenticated: Bool = true
) throws -> PublicProviderAccountResponse {
    try JSONDecoder().decode(
        PublicProviderAccountResponse.self,
        from: Data(
            """
            {
              "id": "\(id)",
              "name": "\(id)",
              "provider": "\(provider)",
              "credentials": null,
              "hasCredentials": \(authenticated),
              "createdAt": "",
              "updatedAt": ""
            }
            """.utf8
        )
    )
}

@Test func failoverEligibilityMapsAuthenticatedProvidersToRuntime() throws {
    let cases = [
        ("anthropic", "claude"),
        ("max", "claude"),
        ("openai", "codex"),
        ("openrouter", "codex"),
        ("copilot", "copilot"),
        ("pi", "pi"),
    ]

    for (provider, runtime) in cases {
        let account = try failoverAccount(id: provider, provider: provider)
        #expect(ProviderFailoverTargetEligibility.isEligible(account))
        #expect(ProviderFailoverTargetEligibility.compatibleRuntimes(for: account) == [runtime])
    }
}

@Test func failoverEligibilityRejectsUnauthenticatedAndUnsafeProvider() throws {
    let unauthenticated = try failoverAccount(
        id: "copilot",
        provider: "copilot",
        authenticated: false
    )
    let unknown = try failoverAccount(id: "unknown", provider: "unknown")

    #expect(!ProviderFailoverTargetEligibility.isEligible(unauthenticated))
    #expect(!ProviderFailoverTargetEligibility.isEligible(unknown))
    #expect(ProviderFailoverTargetEligibility.compatibleRuntimes(for: unknown).isEmpty)
}

@Test func failoverEligibilityRejectsApiProvidersWithoutAuthenticationEvidence() throws {
    let anthropic = try failoverAccount(
        id: "anthropic-env",
        provider: "anthropic",
        authenticated: false
    )
    let openai = try failoverAccount(
        id: "openai-env",
        provider: "openai",
        authenticated: false
    )

    #expect(!ProviderFailoverTargetEligibility.isEligible(anthropic))
    #expect(!ProviderFailoverTargetEligibility.isEligible(openai))
}

@Test func failoverEligibilityRejectsFoundryWithoutRuntimeEvidence() throws {
    let foundry = try failoverAccount(id: "foundry", provider: "foundry")

    #expect(!ProviderFailoverTargetEligibility.isEligible(foundry))
    #expect(ProviderFailoverTargetEligibility.compatibleRuntimes(for: foundry).isEmpty)
}

@Test func failoverModelOptionsUseRuntimeCatalogAndPreserveCompatibleCurrentValue() {
    let codexOptions = ProviderFailoverModelSelection.options(
        runtime: "codex",
        currentValue: "gpt-5.6-sol"
    )
    #expect(
        codexOptions.contains {
            $0.value == "gpt-5.6-sol" && $0.label == "GPT-5.6 Sol"
        }
    )

    let compatibleUnknown = ProviderFailoverModelSelection.options(
        runtime: "codex",
        currentValue: "future-codex-model"
    )
    #expect(
        compatibleUnknown.contains {
            $0.value == "future-codex-model" && $0.label == "future-codex-model"
        }
    )

    let legacyClaude = ProviderFailoverModelSelection.options(
        runtime: "claude",
        currentValue: "opus"
    )
    #expect(
        legacyClaude.contains {
            $0.value == "opus" && $0.label == "Opus 4.8"
        }
    )
    #expect(!legacyClaude.contains { $0.value == "claude-opus-4-8" })
}

@Test func failoverModelSelectionDefaultsAndNormalizesWhenRuntimeChanges() {
    #expect(ProviderFailoverModelSelection.defaultModel(for: "codex") == "auto")
    #expect(
        ProviderFailoverModelSelection.normalized(
            "claude-opus-5",
            changingTo: "codex"
        ) == "auto"
    )
    #expect(
        ProviderFailoverModelSelection.normalized(
            "gpt-5.6-sol",
            changingTo: "codex"
        ) == "gpt-5.6-sol"
    )
}

@Test func failoverValidationAcceptsCompleteOrderedTargets() throws {
    let accounts = [
        try failoverAccount(id: "openai", provider: "openai"),
        try failoverAccount(id: "copilot", provider: "copilot"),
    ]
    let policy = ProviderFailoverPolicyResponse(
        targets: [
            .init(providerAccountId: "openai", runtime: "codex", model: "gpt-5"),
            .init(providerAccountId: "copilot", runtime: "copilot", model: "auto"),
        ],
        maxHops: 1
    )

    #expect(
        validateProviderFailoverPolicy(policy, accounts: accounts, excludedAccountId: "source")
            == nil
    )
}

@Test func failoverValidationRejectsIdentityAndCompletenessErrors() throws {
    let openai = try failoverAccount(id: "openai", provider: "openai")

    let duplicate = ProviderFailoverPolicyResponse(targets: [
        .init(providerAccountId: "openai", runtime: "codex", model: "gpt-5"),
        .init(providerAccountId: "openai", runtime: "codex", model: "gpt-5-mini"),
    ])
    #expect(
        validateProviderFailoverPolicy(duplicate, accounts: [openai], excludedAccountId: nil)?
            .contains("only once") == true
    )

    let selfReference = ProviderFailoverPolicyResponse(targets: [
        .init(providerAccountId: "openai", runtime: "codex", model: "gpt-5"),
    ])
    #expect(
        validateProviderFailoverPolicy(
            selfReference,
            accounts: [openai],
            excludedAccountId: "openai"
        )?.contains("itself") == true
    )

    let missingModel = ProviderFailoverPolicyResponse(targets: [
        .init(providerAccountId: "openai", runtime: "codex", model: " "),
    ])
    #expect(
        validateProviderFailoverPolicy(missingModel, accounts: [openai], excludedAccountId: nil)?
            .contains("needs a model") == true
    )
}

@Test func failoverValidationRejectsRuntimeAuthenticationBoundsAndHops() throws {
    let openai = try failoverAccount(id: "openai", provider: "openai")
    let unauthenticated = try failoverAccount(
        id: "copilot",
        provider: "copilot",
        authenticated: false
    )

    let wrongRuntime = ProviderFailoverPolicyResponse(targets: [
        .init(providerAccountId: "openai", runtime: "claude", model: "gpt-5"),
    ])
    #expect(
        validateProviderFailoverPolicy(wrongRuntime, accounts: [openai], excludedAccountId: nil)?
            .contains("incompatible") == true
    )

    let noAuth = ProviderFailoverPolicyResponse(targets: [
        .init(providerAccountId: "copilot", runtime: "copilot", model: "auto"),
    ])
    #expect(
        validateProviderFailoverPolicy(noAuth, accounts: [unauthenticated], excludedAccountId: nil)?
            .contains("not authenticated") == true
    )

    let tooMany = ProviderFailoverPolicyResponse(
        targets: (0..<9).map {
            .init(providerAccountId: "account-\($0)", runtime: "codex", model: "gpt-5")
        }
    )
    #expect(
        validateProviderFailoverPolicy(tooMany, accounts: [], excludedAccountId: nil)?
            .contains("at most 8") == true
    )

    let invalidHops = ProviderFailoverPolicyResponse(
        targets: [.init(providerAccountId: "openai", runtime: "codex", model: "gpt-5")],
        maxHops: 2
    )
    #expect(
        validateProviderFailoverPolicy(invalidHops, accounts: [openai], excludedAccountId: nil)?
            .contains("Maximum hops") == true
    )
}
