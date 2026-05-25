struct RuntimeModelOption: Hashable, Sendable {
    let value: String
    let label: String
}

enum RuntimeModelRole: Sendable {
    case defaultModel
    case reviewerModel
}

enum RuntimeModelOptions {
    static func options(
        for runtime: RuntimeType,
        role: RuntimeModelRole,
        currentValue: String? = nil
    ) -> [RuntimeModelOption] {
        var options = baseOptions(for: runtime, role: role)
        guard let currentValue, !currentValue.isEmpty else { return options }
        guard !options.contains(where: { $0.value == currentValue }) else { return options }
        guard isCompatible(currentValue, with: runtime) else { return options }

        options.append(RuntimeModelOption(value: currentValue, label: currentValue))
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
        return isCompatible(model, with: runtime) ? model : fallback(for: runtime, role: role)
    }

    static func label(for model: String, runtime: RuntimeType) -> String {
        guard !model.isEmpty else { return "(inherited)" }
        return options(for: runtime, role: .defaultModel, currentValue: model)
            .first(where: { $0.value == model })?
            .label ?? model
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
                    RuntimeModelOption(value: "opus", label: "Opus"),
                    RuntimeModelOption(value: "sonnet", label: "Sonnet"),
                ]
            case .reviewerModel:
                return [
                    RuntimeModelOption(value: "sonnet", label: "Sonnet"),
                    RuntimeModelOption(value: "opus", label: "Opus"),
                ]
            }
        case .codex:
            return [
                RuntimeModelOption(value: "auto", label: "Auto"),
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
}
