import Testing
@testable import AutopodUI

@Test func codexModelOptionsExposeRepoKnownModels() {
    let options = RuntimeModelOptions.options(for: .codex, role: .defaultModel).map(\.value)

    #expect(options == [
        "auto",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.3-codex",
        "gpt-5.5",
        "gpt-5",
        "gpt-5-mini",
    ])
    #expect(!options.contains("opus"))
    #expect(!options.contains("sonnet"))
}

@Test func claudeModelOptionsUseRoleSpecificOrdering() {
    let defaultOptions = RuntimeModelOptions.options(for: .claude, role: .defaultModel).map(\.value)
    let reviewerOptions = RuntimeModelOptions.options(for: .claude, role: .reviewerModel).map(\.value)

    #expect(defaultOptions == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
    ])
    #expect(reviewerOptions == [
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-fable-5",
        "claude-sonnet-4-6",
        "claude-opus-4-8",
        "claude-haiku-4-5",
    ])
    #expect(RuntimeModelOptions.fallback(for: .claude, role: .defaultModel) == "claude-opus-5")
    #expect(RuntimeModelOptions.fallback(for: .claude, role: .reviewerModel) == "claude-sonnet-5")
}

@Test func claude5OptionsUseExactLabelsAndStandardPrices() {
    let options = RuntimeModelOptions.options(for: .claude, role: .defaultModel)
    let labels = Dictionary(uniqueKeysWithValues: options.map { ($0.value, $0.label) })

    #expect(labels["claude-fable-5"] == "Fable 5")
    #expect(labels["claude-opus-5"] == "Opus 5")
    #expect(labels["claude-sonnet-5"] == "Sonnet 5")
    #expect(
        RuntimeModelOptions.priceSummary(for: "claude-fable-5", runtime: .claude)
            == "$10 in / $1 cached / $50 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "claude-opus-5", runtime: .claude)
            == "$5 in / $0.50 cached / $25 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "claude-sonnet-5", runtime: .claude)
            == "$3 in / $0.30 cached / $15 out per 1M"
    )
}

@Test func runtimeModelNormalizationResetsIncompatibleSelections() {
    #expect(
        RuntimeModelOptions.normalized("opus", for: .codex, role: .defaultModel) == "auto"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .defaultModel) == "claude-opus-5"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .reviewerModel) == "claude-sonnet-5"
    )
    #expect(
        RuntimeModelOptions.normalized("sonnet", for: .copilot, role: .defaultModel) == "auto"
    )
}

@Test func runtimeModelNormalizationExpandsClaudeAliases() {
    #expect(
        RuntimeModelOptions.normalized("opus", for: .claude, role: .defaultModel)
            == "claude-opus-4-8"
    )
    #expect(
        RuntimeModelOptions.normalized("sonnet", for: .claude, role: .reviewerModel)
            == "claude-sonnet-4-6"
    )
}

@Test(arguments: [
    ("claude-opus-4-7", "Opus 4.7"),
    ("claude-opus-4-6", "Opus 4.6"),
    ("claude-sonnet-4-5", "Sonnet 4.5"),
])
func claudeModelOptionsPreserveExplicitCanonical4xValues(
    input: (String, String)
) {
    let (model, expectedLabel) = input
    let options = RuntimeModelOptions.options(
        for: .claude,
        role: .defaultModel,
        currentValue: model
    )

    #expect(options.map(\.value) == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        model,
    ])
    #expect(options.last?.label == expectedLabel)
}

@Test func codexModelOptionsPreserveCompatibleCustomCurrentValue() {
    let options = RuntimeModelOptions.options(
        for: .codex,
        role: .defaultModel,
        currentValue: "gpt-5.2-codex"
    ).map(\.value)

    #expect(
        options == [
            "auto",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.3-codex",
            "gpt-5.5",
            "gpt-5",
            "gpt-5-mini",
            "gpt-5.2-codex",
        ]
    )
}

@Test func openAiProviderNormalizationCanResetRestrictedCodexModel() {
    #expect(
        RuntimeModelOptions.normalized(
            "gpt-5-codex",
            for: .codex,
            role: .defaultModel,
            resetCodexRestrictedModel: true
        ) == "auto"
    )
}

@Test func modelPricingSummariesCoverPickerModels() {
    #expect(
        RuntimeModelOptions.priceSummary(for: "gpt-5.6-sol", runtime: .codex)
            == "$5 in / $0.50 cached / $30 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "gpt-5.6-terra", runtime: .codex)
            == "$2.5 in / $0.25 cached / $15 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "gpt-5.6-luna", runtime: .codex)
            == "$1 in / $0.10 cached / $6 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "gpt-5.5", runtime: .codex)
            == "$5 in / $0.50 cached / $30 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "claude-opus-4-8", runtime: .claude)
            == "$5 in / $0.50 cached / $25 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "gpt-5.2-codex", runtime: .codex)
            == "$1.75 in / $0.175 cached / $14 out per 1M"
    )
    #expect(
        RuntimeModelOptions.priceSummary(for: "auto", runtime: .codex)
            == "Uses the Codex account default; pricing varies"
    )
}

@Test func piModelsAreProviderQualifiedAndDistinctFromVendorDefaults() {
    let piOptions = RuntimeModelOptions.options(for: .pi, role: .defaultModel).map(\.value)

    #expect(piOptions == [
        "auto",
        "anthropic/claude-sonnet-4",
        "openai-codex/gpt-5.3-codex",
        "github-copilot/gpt-5.2-codex",
    ])
    #expect(RuntimeModelOptions.fallback(for: .pi, role: .defaultModel) == "auto")
    #expect(RuntimeModelOptions.fallback(for: .claude, role: .defaultModel) != "auto")
    #expect(RuntimeModelOptions.options(for: .codex, role: .defaultModel).map(\.value) != piOptions)
    #expect(RuntimeModelOptions.options(for: .copilot, role: .defaultModel).map(\.value) != piOptions)
}

@Test func switchingRuntimesPreservesOnlyCompatibleSelections() {
    #expect(
        RuntimeModelOptions.normalized(
            "anthropic/claude-sonnet-4",
            for: .pi,
            role: .defaultModel
        ) == "anthropic/claude-sonnet-4"
    )
    #expect(
        RuntimeModelOptions.normalized("claude-opus-4-8", for: .pi, role: .defaultModel) == "auto"
    )
    #expect(
        RuntimeModelOptions.normalized("anthropic/claude-sonnet-4", for: .claude, role: .defaultModel)
            == "claude-opus-5"
    )
    #expect(RuntimeModelOptions.normalized("auto", for: .copilot, role: .defaultModel) == "auto")
}
