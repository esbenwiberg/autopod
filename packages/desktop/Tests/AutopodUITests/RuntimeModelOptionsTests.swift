import Testing
@testable import AutopodUI

@Test func codexModelOptionsExposeRepoKnownModels() {
    let options = RuntimeModelOptions.options(for: .codex, role: .defaultModel).map(\.value)

    #expect(options == ["auto", "gpt-5.3-codex", "gpt-5.5", "gpt-5", "gpt-5-mini"])
    #expect(!options.contains("opus"))
    #expect(!options.contains("sonnet"))
}

@Test func claudeModelOptionsUseRoleSpecificOrdering() {
    let defaultOptions = RuntimeModelOptions.options(for: .claude, role: .defaultModel).map(\.value)
    let reviewerOptions = RuntimeModelOptions.options(for: .claude, role: .reviewerModel).map(\.value)

    #expect(defaultOptions == ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"])
    #expect(reviewerOptions == ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"])
}

@Test func runtimeModelNormalizationResetsIncompatibleSelections() {
    #expect(
        RuntimeModelOptions.normalized("opus", for: .codex, role: .defaultModel) == "auto"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .defaultModel) == "claude-opus-4-8"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .reviewerModel) == "claude-sonnet-4-6"
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

@Test func claudeModelOptionsPreserveExplicitCanonicalOpus47() {
    let options = RuntimeModelOptions.options(
        for: .claude,
        role: .defaultModel,
        currentValue: "claude-opus-4-7"
    )

    #expect(options.map(\.value) == [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "claude-opus-4-7",
    ])
    #expect(options.last?.label == "Opus 4.7")
}

@Test func codexModelOptionsPreserveCompatibleCustomCurrentValue() {
    let options = RuntimeModelOptions.options(
        for: .codex,
        role: .defaultModel,
        currentValue: "gpt-5.2-codex"
    ).map(\.value)

    #expect(
        options == ["auto", "gpt-5.3-codex", "gpt-5.5", "gpt-5", "gpt-5-mini", "gpt-5.2-codex"]
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
