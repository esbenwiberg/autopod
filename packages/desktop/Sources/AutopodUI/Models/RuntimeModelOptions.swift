import Foundation

struct RuntimeModelOption: Hashable, Sendable {
    let value: String
    let label: String
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

enum RuntimeModelOptions {
    private static let modelPricing: [String: RuntimeModelPrice] = [
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
        "claude-opus-4-8": "Opus 4.8",
        "claude-opus-4-7": "Opus 4.7",
        "claude-opus-4-6": "Opus 4.6",
        "claude-sonnet-4-6": "Sonnet 4.6",
        "claude-sonnet-4-5": "Sonnet 4.5",
        "claude-haiku-4-5": "Haiku 4.5",
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
    ]

    static func options(
        for runtime: RuntimeType,
        role: RuntimeModelRole,
        currentValue: String? = nil
    ) -> [RuntimeModelOption] {
        var options = baseOptions(for: runtime, role: role)
        guard let currentValue, !currentValue.isEmpty else { return options }

        let canonicalCurrentValue = canonicalValue(for: currentValue)
        guard !options.contains(where: { $0.value == canonicalCurrentValue }) else { return options }
        guard isCompatible(canonicalCurrentValue, with: runtime) else { return options }

        options.append(RuntimeModelOption(
            value: canonicalCurrentValue,
            label: modelLabels[canonicalCurrentValue] ?? canonicalCurrentValue
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
            }
        }

        let canonicalModel = canonicalValue(for: model)
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
                    RuntimeModelOption(value: "claude-opus-4-8", label: "Opus 4.8"),
                    RuntimeModelOption(value: "claude-sonnet-4-6", label: "Sonnet 4.6"),
                    RuntimeModelOption(value: "claude-haiku-4-5", label: "Haiku 4.5"),
                ]
            case .reviewerModel:
                return [
                    RuntimeModelOption(value: "claude-sonnet-4-6", label: "Sonnet 4.6"),
                    RuntimeModelOption(value: "claude-opus-4-8", label: "Opus 4.8"),
                    RuntimeModelOption(value: "claude-haiku-4-5", label: "Haiku 4.5"),
                ]
            }
        case .codex:
            return [
                RuntimeModelOption(value: "auto", label: "Auto"),
                RuntimeModelOption(value: "gpt-5.6-sol", label: "GPT-5.6 Sol"),
                RuntimeModelOption(value: "gpt-5.6-terra", label: "GPT-5.6 Terra"),
                RuntimeModelOption(value: "gpt-5.6-luna", label: "GPT-5.6 Luna"),
                RuntimeModelOption(value: "gpt-5.3-codex", label: "GPT-5.3-Codex"),
                RuntimeModelOption(value: "gpt-5.5", label: "GPT-5.5"),
                RuntimeModelOption(value: "gpt-5", label: "GPT-5"),
                RuntimeModelOption(value: "gpt-5-mini", label: "GPT-5 Mini"),
            ]
        case .copilot:
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
}
