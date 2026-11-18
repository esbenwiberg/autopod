import AutopodClient
import Foundation

public struct RuntimeModelOption: Hashable, Sendable, Identifiable {
    public let value: String
    public let label: String

    public var id: String { value }
}

struct RuntimeModelPrice: Hashable, Sendable {
    let inputPer1M: Double
    let cachedInputPer1M: Double?
    let outputPer1M: Double

    var summary: String {
        if let cachedInputPer1M {
            return "\(Self.usd(inputPer1M)) in / \(Self.usd(cachedInputPer1M)) cached / \(Self.usd(outputPer1M)) out per 1M"
        }
        return "\(Self.usd(inputPer1M)) in / \(Self.usd(outputPer1M)) out per 1M"
    }

    private static func usd(_ value: Double) -> String {
        if value.rounded() == value {
            return "$\(Int(value))"
        }

        if value < 1 && (value * 100).rounded() == value * 100 {
            return "$\(String(format: "%.2f", value))"
        }

        let precision = value < 1 ? "%.3f" : "%.2f"
        let formatted = String(format: precision, value)
            .replacingOccurrences(of: #"0+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
        return "$\(formatted)"
    }
}

enum RuntimeModelRole: Sendable {
    case defaultModel
    case reviewerModel
}

public enum ClaudeModelCanonicalizer {
    private static let modelAliases: [String: String] = [
        "opus": "claude-opus-4-8",
        "sonnet": "claude-sonnet-4-6",
        "haiku": "claude-haiku-4-5",
    ]

    public static func normalizedLegacyAlias(_ model: String) -> String {
        modelAliases[model] ?? model
    }
}

public enum RuntimeModelOptions {
    private static let modelPricing: [String: RuntimeModelPrice] = [
        "gpt-6.2-astra": RuntimeModelPrice(inputPer1M: 8, cachedInputPer1M: 0.4, outputPer1M: 40),
        "gpt-6.2-sol": RuntimeModelPrice(inputPer1M: 2, cachedInputPer1M: 0.1, outputPer1M: 10),
        "gpt-6.1-terra": RuntimeModelPrice(inputPer1M: 1, cachedInputPer1M: 0.05, outputPer1M: 5),
        "claude-fable-5-2": RuntimeModelPrice(inputPer1M: 8, cachedInputPer1M: 0.2, outputPer1M: 40),
        "claude-haiku-5-5": RuntimeModelPrice(inputPer1M: 0.1, cachedInputPer1M: 0.01, outputPer1M: 0.5),
        "claude-fable-5-1": RuntimeModelPrice(
            inputPer1M: 10,
            cachedInputPer1M: 0.25,
            outputPer1M: 50
        ),
        "claude-opus-5-5": RuntimeModelPrice(
            inputPer1M: 4,
            cachedInputPer1M: 0.2,
            outputPer1M: 20
        ),
        "claude-sonnet-5-5": RuntimeModelPrice(
            inputPer1M: 2,
            cachedInputPer1M: 0.2,
            outputPer1M: 10
        ),
        "claude-fable-5": RuntimeModelPrice(
            inputPer1M: 10,
            cachedInputPer1M: 1,
            outputPer1M: 50
        ),
        "claude-opus-5": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 25
        ),
        "claude-sonnet-5": RuntimeModelPrice(
            inputPer1M: 2,
            cachedInputPer1M: 0.2,
            outputPer1M: 10
        ),
        "claude-opus-4-8": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 25
        ),
        "claude-opus-4-7": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 25
        ),
        "claude-opus-4-6": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 25
        ),
        "claude-sonnet-4-6": RuntimeModelPrice(
            inputPer1M: 3,
            cachedInputPer1M: 0.3,
            outputPer1M: 15
        ),
        "claude-sonnet-4-5": RuntimeModelPrice(
            inputPer1M: 3,
            cachedInputPer1M: 0.3,
            outputPer1M: 15
        ),
        "claude-haiku-4-5": RuntimeModelPrice(
            inputPer1M: 1,
            cachedInputPer1M: 0.1,
            outputPer1M: 5
        ),
        "gpt-6-astra": RuntimeModelPrice(
            inputPer1M: 10,
            cachedInputPer1M: 1,
            outputPer1M: 50
        ),
        "gpt-6.1-sol": RuntimeModelPrice(
            inputPer1M: 2,
            cachedInputPer1M: 0.1,
            outputPer1M: 10
        ),
        "gpt-6-sol": RuntimeModelPrice(
            inputPer1M: 2,
            cachedInputPer1M: 0.2,
            outputPer1M: 10
        ),
        "gpt-6-luna": RuntimeModelPrice(
            inputPer1M: 0.1,
            cachedInputPer1M: 0.01,
            outputPer1M: 0.5
        ),
        "gpt-5.6-sol": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 30
        ),
        "gpt-5.6-terra": RuntimeModelPrice(
            inputPer1M: 2.5,
            cachedInputPer1M: 0.25,
            outputPer1M: 15
        ),
        "gpt-5.6-luna": RuntimeModelPrice(
            inputPer1M: 1,
            cachedInputPer1M: 0.1,
            outputPer1M: 6
        ),
        "gpt-5.5": RuntimeModelPrice(
            inputPer1M: 5,
            cachedInputPer1M: 0.5,
            outputPer1M: 30
        ),
        "gpt-5.3-codex": RuntimeModelPrice(
            inputPer1M: 1.75,
            cachedInputPer1M: 0.175,
            outputPer1M: 14
        ),
        "gpt-5.2-codex": RuntimeModelPrice(
            inputPer1M: 1.75,
            cachedInputPer1M: 0.175,
            outputPer1M: 14
        ),
        "gpt-5.1-codex-max": RuntimeModelPrice(
            inputPer1M: 1.25,
            cachedInputPer1M: 0.125,
            outputPer1M: 10
        ),
        "gpt-5.1-codex": RuntimeModelPrice(
            inputPer1M: 1.25,
            cachedInputPer1M: 0.125,
            outputPer1M: 10
        ),
        "gpt-5.1-codex-mini": RuntimeModelPrice(
            inputPer1M: 0.25,
            cachedInputPer1M: 0.025,
            outputPer1M: 2
        ),
        "gpt-5-codex": RuntimeModelPrice(
            inputPer1M: 1.25,
            cachedInputPer1M: 0.125,
            outputPer1M: 10
        ),
        "codex-mini-latest": RuntimeModelPrice(
            inputPer1M: 1.5,
            cachedInputPer1M: 0.375,
            outputPer1M: 6
        ),
        "gpt-5": RuntimeModelPrice(
            inputPer1M: 1.25,
            cachedInputPer1M: 0.125,
            outputPer1M: 10
        ),
        "gpt-5-mini": RuntimeModelPrice(
            inputPer1M: 0.25,
            cachedInputPer1M: 0.025,
            outputPer1M: 2
        ),
    ]

    private static let modelLabels: [String: String] = [
        "anthropic/claude-sonnet-4": "Anthropic · Claude Sonnet 4",
        "openai-codex/gpt-5.3-codex": "OpenAI Codex · GPT-5.3-Codex",
        "github-copilot/gpt-5.2-codex": "GitHub Copilot · GPT-5.2-Codex",
        "gpt-6.2-astra": "GPT-6.2 Astra",
        "gpt-6.2-sol": "GPT-6.2 Sol",
        "gpt-6.1-terra": "GPT-6.1 Terra",
        "claude-fable-5-2": "Fable 5.2",
        "claude-haiku-5-5": "Haiku 5.5",
        "claude-fable-5-1": "Fable 5.1",
        "claude-opus-5-5": "Opus 5.5",
        "claude-sonnet-5-5": "Sonnet 5.5",
        "claude-fable-5": "Fable 5",
        "claude-opus-5": "Opus 5",
        "claude-sonnet-5": "Sonnet 5",
        "claude-opus-4-8": "Opus 4.8",
        "claude-opus-4-7": "Opus 4.7",
        "claude-opus-4-6": "Opus 4.6",
        "claude-sonnet-4-6": "Sonnet 4.6",
        "claude-sonnet-4-5": "Sonnet 4.5",
        "claude-haiku-4-5": "Haiku 4.5",
        "gpt-6-astra": "GPT-6 Astra",
        "gpt-6.1-sol": "GPT-6.1 Sol",
        "gpt-6-sol": "GPT-6 Sol",
        "gpt-6-luna": "GPT-6 Luna",
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
        "gpt-5.3-codex": "GPT-5.3-Codex",
        "gpt-5.5": "GPT-5.5",
        "gpt-5": "GPT-5",
        "gpt-5-mini": "GPT-5 Mini",
    ]

    public static func defaultOptions(
        for runtime: RuntimeType,
        currentValue: String? = nil,
        catalog: ProviderCatalogResponse? = nil,
        providerId: String? = nil
    ) -> [RuntimeModelOption] {
        options(
            for: runtime,
            role: .defaultModel,
            currentValue: currentValue,
            catalog: catalog,
            providerId: providerId
        )
    }

    static func options(
        for runtime: RuntimeType,
        role: RuntimeModelRole,
        currentValue: String? = nil,
        catalog: ProviderCatalogResponse? = nil,
        providerId: String? = nil
    ) -> [RuntimeModelOption] {
        var options = baseOptions(for: runtime, role: role)
        if runtime == .pi, let catalog, let providerId,
           let provider = catalog.provider(id: providerId),
           provider.implementation.kind == "generic-pi-api" {
            guard provider.policy.runnable, provider.policy.authorization == "supported" else {
                return []
            }
            options = catalog.models
                .filter {
                    $0.providerId == providerId
                        && provider.modelIds.contains($0.id)
                }
                .filter { $0.lifecycle == "active" }
                .map { RuntimeModelOption(value: $0.id, label: $0.displayName) }
        }
        guard let currentValue, !currentValue.isEmpty else { return options }

        let canonicalCurrentValue = canonicalValue(for: currentValue)
        guard !options.contains(where: { $0.value == canonicalCurrentValue }) else { return options }
        guard isCompatible(canonicalCurrentValue, with: runtime) else { return options }

        options.append(RuntimeModelOption(
            value: canonicalCurrentValue,
            label: unavailableLabel(
                for: canonicalCurrentValue,
                runtime: runtime,
                catalog: catalog,
                providerId: providerId
            )
        ))
        return options
    }

    static func fallback(for runtime: RuntimeType, role: RuntimeModelRole) -> String {
        baseOptions(for: runtime, role: role).first?.value ?? "auto"
    }

    static func normalized(
        _ model: String,
        for runtime: RuntimeType,
        role: RuntimeModelRole,
        resetCodexRestrictedModel: Bool = false
    ) -> String {
        if resetCodexRestrictedModel && runtime == .codex && model == "gpt-5-codex" {
            return fallback(for: runtime, role: role)
        }
        let canonicalModel = canonicalValue(for: model)
        return isCompatible(canonicalModel, with: runtime)
            ? canonicalModel
            : fallback(for: runtime, role: role)
    }

    static func label(for model: String, runtime: RuntimeType) -> String {
        guard !model.isEmpty else { return "(inherited)" }
        let canonicalModel = canonicalValue(for: model)
        return options(for: runtime, role: .defaultModel, currentValue: canonicalModel)
            .first(where: { $0.value == canonicalModel })?
            .label ?? canonicalModel
    }

    static func priceSummary(for model: String, runtime: RuntimeType) -> String {
        if model == "auto" {
            switch runtime {
            case .claude:
                return "Uses the runtime default; pricing varies"
            case .codex:
                return "Uses the Codex account default; pricing varies"
            case .copilot:
                return "Controlled by Copilot credentials"
            case .pi:
                return "Uses the selected Pi provider subscription; pricing varies"
            }
        }

        let canonicalModel = canonicalValue(for: model)
        if canonicalModel == "claude-haiku-5-5", let price = modelPricing[canonicalModel] {
            return "From \(price.summary) (prompts ≤100k tokens; above 100k: $0.50 in / $0.05 cached / $2.50 out)"
        }
        return modelPricing[canonicalModel]?.summary ?? "Pricing not in local table"
    }

    static func isCompatible(_ model: String, with runtime: RuntimeType) -> Bool {
        guard !model.isEmpty else { return false }

        switch runtime {
        case .claude:
            return isClaudeModel(model)
        case .codex:
            return model == "auto" || !isClaudeModel(model)
        case .copilot:
            return model == "auto"
        case .pi:
            return model == "auto" || model.contains("/")
        }
    }

    private static func baseOptions(
        for runtime: RuntimeType,
        role: RuntimeModelRole
    ) -> [RuntimeModelOption] {
        switch runtime {
        case .claude:
            switch role {
            case .defaultModel:
                return [
                    RuntimeModelOption(value: "claude-opus-5-5", label: "Opus 5.5"),
                    RuntimeModelOption(value: "claude-sonnet-5-5", label: "Sonnet 5.5"),
                    RuntimeModelOption(value: "claude-fable-5-2", label: "Fable 5.2"),
                    RuntimeModelOption(value: "claude-haiku-5-5", label: "Haiku 5.5"),
                ]
            case .reviewerModel:
                return [
                    RuntimeModelOption(value: "claude-sonnet-5-5", label: "Sonnet 5.5"),
                    RuntimeModelOption(value: "claude-opus-5-5", label: "Opus 5.5"),
                    RuntimeModelOption(value: "claude-fable-5-2", label: "Fable 5.2"),
                    RuntimeModelOption(value: "claude-haiku-5-5", label: "Haiku 5.5"),
                ]
            }
        case .codex:
            return [
                RuntimeModelOption(value: "auto", label: "Auto"),
                RuntimeModelOption(value: "gpt-6.2-sol", label: "GPT-6.2 Sol"),
                RuntimeModelOption(value: "gpt-6.2-astra", label: "GPT-6.2 Astra"),
                RuntimeModelOption(value: "gpt-6.1-terra", label: "GPT-6.1 Terra"),
                RuntimeModelOption(value: "gpt-6-luna", label: "GPT-6 Luna"),
            ]
        case .copilot:
            return [
                RuntimeModelOption(value: "auto", label: "Auto"),
            ]
        case .pi:
            // Explicit choices come from the authorized catalog, not stale provider examples.
            return [
                RuntimeModelOption(value: "auto", label: "Auto"),
            ]
        }
    }

    private static func isClaudeModel(_ model: String) -> Bool {
        ["opus", "sonnet", "haiku"].contains(model) || model.hasPrefix("claude-")
    }

    private static func canonicalValue(for model: String) -> String {
        ClaudeModelCanonicalizer.normalizedLegacyAlias(model)
    }

    private static func unavailableLabel(
        for model: String,
        runtime: RuntimeType,
        catalog: ProviderCatalogResponse?,
        providerId: String?
    ) -> String {
        let label = modelLabels[model] ?? model
        guard runtime == .pi, let providerId,
              catalog?.provider(id: providerId)?.implementation.kind == "generic-pi-api" else {
            let isKnown = modelLabels[model] != nil || modelPricing[model] != nil
            return isKnown ? "\(label) (Legacy)" : label
        }
        return "\(label) (unavailable)"
    }
}
