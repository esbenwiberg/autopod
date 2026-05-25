import Testing
@testable import AutopodUI

@Test func codexModelOptionsExposeRepoKnownModels() {
    let options = RuntimeModelOptions.options(for: .codex, role: .defaultModel).map(\.value)

    #expect(options == ["auto", "gpt-5", "gpt-5-mini"])
    #expect(!options.contains("opus"))
    #expect(!options.contains("sonnet"))
}

@Test func claudeModelOptionsUseRoleSpecificOrdering() {
    let defaultOptions = RuntimeModelOptions.options(for: .claude, role: .defaultModel).map(\.value)
    let reviewerOptions = RuntimeModelOptions.options(for: .claude, role: .reviewerModel).map(\.value)

    #expect(defaultOptions == ["opus", "sonnet"])
    #expect(reviewerOptions == ["sonnet", "opus"])
}

@Test func runtimeModelNormalizationResetsIncompatibleSelections() {
    #expect(
        RuntimeModelOptions.normalized("opus", for: .codex, role: .defaultModel) == "auto"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .defaultModel) == "opus"
    )
    #expect(
        RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .reviewerModel) == "sonnet"
    )
    #expect(
        RuntimeModelOptions.normalized("sonnet", for: .copilot, role: .defaultModel) == "auto"
    )
}

@Test func codexModelOptionsPreserveCompatibleCustomCurrentValue() {
    let options = RuntimeModelOptions.options(
        for: .codex,
        role: .defaultModel,
        currentValue: "gpt-5.2-codex"
    ).map(\.value)

    #expect(options == ["auto", "gpt-5", "gpt-5-mini", "gpt-5.2-codex"])
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
