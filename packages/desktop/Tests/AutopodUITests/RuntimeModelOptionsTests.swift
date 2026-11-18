import Testing
@testable import AutopodUI

private let currentClaude = [
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5",
]
private let currentCodex = [
    "auto", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna",
]

@Test func currentModelOptionsAndRoleOrdering() {
    #expect(RuntimeModelOptions.options(for: .claude, role: .defaultModel).map(\.value) == currentClaude)
    #expect(RuntimeModelOptions.options(for: .claude, role: .reviewerModel).map(\.value) == [
        "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-haiku-5-5",
    ])
    for role in [RuntimeModelRole.defaultModel, .reviewerModel] {
        #expect(RuntimeModelOptions.options(for: .codex, role: role).map(\.value) == currentCodex)
        #expect(RuntimeModelOptions.fallback(for: .codex, role: role) == "auto")
        #expect(RuntimeModelOptions.options(for: .pi, role: role).map(\.value) == ["auto"])
        #expect(RuntimeModelOptions.options(for: .copilot, role: role).map(\.value) == ["auto"])
    }
    #expect(RuntimeModelOptions.fallback(for: .claude, role: .defaultModel) == "claude-opus-5-5")
    #expect(RuntimeModelOptions.fallback(for: .claude, role: .reviewerModel) == "claude-sonnet-5-5")
    let profile = Profile(name: "New profile", repoUrl: "")
    #expect(profile.defaultModel == "claude-opus-5-5")
    #expect(profile.reviewerModel == "claude-sonnet-5-5")
    #expect(profile.escalationAskAiModel == "claude-sonnet-5-5")
}

@Test(arguments: [
    ("claude-fable-5-2", "Fable 5.2", "$8 in / $0.20 cached / $40 out per 1M"),
    ("claude-opus-5-5", "Opus 5.5", "$4 in / $0.20 cached / $20 out per 1M"),
    ("claude-sonnet-5-5", "Sonnet 5.5", "$2 in / $0.20 cached / $10 out per 1M"),
    ("claude-haiku-5-5", "Haiku 5.5", "From $0.10 in / $0.01 cached / $0.50 out per 1M (prompts ≤100k tokens; above 100k: $0.50 in / $0.05 cached / $2.50 out)"),
    ("gpt-6.2-sol", "GPT-6.2 Sol", "$2 in / $0.10 cached / $10 out per 1M"),
    ("gpt-6.2-astra", "GPT-6.2 Astra", "$8 in / $0.40 cached / $40 out per 1M"),
    ("gpt-6.1-terra", "GPT-6.1 Terra", "$1 in / $0.05 cached / $5 out per 1M"),
    ("gpt-6-luna", "GPT-6 Luna", "$0.10 in / $0.01 cached / $0.50 out per 1M"),
])
func currentLabelsAndPrices(input: (String, String, String)) {
    let (model, label, price) = input
    let runtime: RuntimeType = model.hasPrefix("claude-") ? .claude : .codex
    #expect(RuntimeModelOptions.label(for: model, runtime: runtime) == label)
    #expect(RuntimeModelOptions.priceSummary(for: model, runtime: runtime) == price)
    let options = RuntimeModelOptions.options(for: runtime, role: .defaultModel, currentValue: model)
    #expect(options.filter { $0.value == model }.count == 1)
}

@Test(arguments: [
    ("claude-opus-4-8", "Opus 4.8"), ("claude-opus-4-7", "Opus 4.7"),
    ("claude-opus-4-6", "Opus 4.6"), ("claude-sonnet-4-6", "Sonnet 4.6"),
    ("claude-sonnet-4-5", "Sonnet 4.5"), ("claude-haiku-4-5", "Haiku 4.5"),
    ("claude-fable-5", "Fable 5"), ("claude-fable-5-1", "Fable 5.1"),
    ("claude-opus-5", "Opus 5"), ("claude-sonnet-5", "Sonnet 5"),
    ("gpt-6.1-sol", "GPT-6.1 Sol"), ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-6-sol", "GPT-6 Sol"), ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"), ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-5.3-codex", "GPT-5.3-Codex"), ("gpt-5.5", "GPT-5.5"),
    ("gpt-5", "GPT-5"), ("gpt-5-mini", "GPT-5 Mini"),
    ("gpt-5.2-codex", "gpt-5.2-codex"),
])
func savedLegacyChoicesArePreservedOnce(input: (String, String)) {
    let (model, label) = input
    let runtime: RuntimeType = model.hasPrefix("claude-") ? .claude : .codex
    for role in [RuntimeModelRole.defaultModel, .reviewerModel] {
        let base = RuntimeModelOptions.options(for: runtime, role: role)
        let options = RuntimeModelOptions.options(for: runtime, role: role, currentValue: model)
        #expect(options.map(\.value) == base.map(\.value) + [model])
        #expect(options.last?.label == "\(label) (Legacy)")
        #expect(options.filter { $0.value == model }.count == 1)
        #expect(RuntimeModelOptions.normalized(model, for: runtime, role: role) == model)
    }
}

@Test func historicalAliasesAndPricesStayStable() {
    #expect(ClaudeModelCanonicalizer.normalizedLegacyAlias("opus") == "claude-opus-4-8")
    #expect(ClaudeModelCanonicalizer.normalizedLegacyAlias("sonnet") == "claude-sonnet-4-6")
    #expect(ClaudeModelCanonicalizer.normalizedLegacyAlias("haiku") == "claude-haiku-4-5")
    let options = RuntimeModelOptions.options(for: .claude, role: .defaultModel, currentValue: "opus")
    #expect(options.map(\.value) == currentClaude + ["claude-opus-4-8"])
    #expect(options.last?.label == "Opus 4.8 (Legacy)")
    #expect(RuntimeModelOptions.priceSummary(for: "opus", runtime: .claude) == "$5 in / $0.50 cached / $25 out per 1M")
    #expect(RuntimeModelOptions.priceSummary(for: "claude-fable-5-1", runtime: .claude) == "$10 in / $0.25 cached / $50 out per 1M")
    #expect(RuntimeModelOptions.priceSummary(for: "gpt-6-astra", runtime: .codex) == "$10 in / $1 cached / $50 out per 1M")
}

@Test(arguments: [
    ("anthropic/claude-sonnet-4", "Anthropic · Claude Sonnet 4"),
    ("openai-codex/gpt-5.3-codex", "OpenAI Codex · GPT-5.3-Codex"),
    ("github-copilot/gpt-5.2-codex", "GitHub Copilot · GPT-5.2-Codex"),
])
func savedPiExamplesRetainLabels(input: (String, String)) {
    let (model, label) = input
    let options = RuntimeModelOptions.options(for: .pi, role: .defaultModel, currentValue: model)
    #expect(options.map(\.value) == ["auto", model])
    #expect(options.last?.label == "\(label) (Legacy)")
    #expect(RuntimeModelOptions.normalized(model, for: .pi, role: .defaultModel) == model)
}

@Test func customCompatibilityAndRestrictedModels() {
    for (runtime, model) in [(RuntimeType.claude, "claude-custom"), (.codex, "custom-coder"), (.pi, "custom/model")] {
        let options = RuntimeModelOptions.options(for: runtime, role: .defaultModel, currentValue: model)
        #expect(options.last?.value == model)
        #expect(options.last?.label == model)
        #expect(RuntimeModelOptions.normalized(model, for: runtime, role: .defaultModel) == model)
    }
    #expect(RuntimeModelOptions.normalized("opus", for: .codex, role: .defaultModel) == "auto")
    #expect(RuntimeModelOptions.normalized("gpt-5", for: .claude, role: .reviewerModel) == "claude-sonnet-5-5")
    #expect(RuntimeModelOptions.normalized("claude-custom", for: .pi, role: .defaultModel) == "auto")
    #expect(RuntimeModelOptions.normalized("custom", for: .copilot, role: .defaultModel) == "auto")
    #expect(RuntimeModelOptions.normalized("gpt-5-codex", for: .codex, role: .defaultModel) == "gpt-5-codex")
    #expect(RuntimeModelOptions.normalized("gpt-5-codex", for: .codex, role: .defaultModel, resetCodexRestrictedModel: true) == "auto")
    #expect(RuntimeModelOptions.options(for: .claude, role: .defaultModel, currentValue: "gpt-5").map(\.value) == currentClaude)
}
