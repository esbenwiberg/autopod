import Foundation

// MARK: - PodConfig axes (mirrors packages/shared/src/types/pod.ts)

public enum AgentMode: String, CaseIterable, Sendable {
    case auto          // Agent runs to completion
    case interactive   // No agent; human drives the container

    public var label: String {
        switch self {
        case .auto:        "Agent"
        case .interactive: "Interactive"
        }
    }

    public var description: String {
        switch self {
        case .auto:        "Agent runs to completion"
        case .interactive: "Human drives the container"
        }
    }
}

public enum OutputTarget: String, CaseIterable, Sendable {
    case pr        // Push branch + open PR (requires repoUrl)
    case branch    // Push branch only
    case artifact  // Extract /workspace to dataDir
    case none      // Ephemeral; nothing leaves the container

    public var label: String {
        switch self {
        case .pr:       "Pull Request"
        case .branch:   "Branch Push"
        case .artifact: "Artifact"
        case .none:     "Ephemeral"
        }
    }

    public var description: String {
        switch self {
        case .pr:       "Push branch and open a PR"
        case .branch:   "Push branch only, no PR"
        case .artifact: "Extract workspace to artifact dir"
        case .none:     "No output — container is discarded"
        }
    }
}

public enum AdvisoryBrowserQaMode: String, CaseIterable, Sendable {
    case inherit
    case enabled
    case disabled

    public var label: String {
        switch self {
        case .inherit:  "Auto"
        case .enabled:  "Enabled"
        case .disabled: "Disabled"
        }
    }

    public init(value: Bool?) {
        switch value {
        case .some(true):  self = .enabled
        case .some(false): self = .disabled
        case .none:        self = .inherit
        }
    }

    public var value: Bool? {
        switch self {
        case .inherit:  nil
        case .enabled:  true
        case .disabled: false
        }
    }
}

public let validationSuiteOptions = [
    "off",
    "thin",
    "thin-with-facts",
    "deterministic",
    "full",
    "custom",
]

public struct PodConfig: Sendable, Equatable {
    public var agentMode: AgentMode
    public var output: OutputTarget
    /// Run validation before completing.
    public var validate: Bool
    /// Autopod pre-PR validation suite. GitHub PR checks remain repo-owned.
    public var validationSuite: String
    /// Optional evidence-only browser QA. Nil means inherit / use the daemon default.
    public var advisoryBrowserQaEnabled: Bool?
    /// Allow promoting this pod to a different mode later.
    public var promotable: Bool

    public init(
        agentMode: AgentMode = .auto,
        output: OutputTarget = .pr,
        validate: Bool = true,
        validationSuite: String = "full",
        advisoryBrowserQaEnabled: Bool? = nil,
        promotable: Bool = false
    ) {
        self.agentMode = agentMode
        self.output = output
        self.validate = validate
        self.validationSuite = validationSuite
        self.advisoryBrowserQaEnabled = advisoryBrowserQaEnabled
        self.promotable = promotable
    }

    /// Map a legacy `outputMode` string (pr/artifact/workspace) to a PodConfig.
    public static func fromLegacy(_ outputMode: String) -> PodConfig {
        switch outputMode {
        case "pr":
            return PodConfig(
                agentMode: .auto, output: .pr, validate: true, validationSuite: "full",
                promotable: false
            )
        case "artifact":
            return PodConfig(
                agentMode: .auto, output: .artifact, validate: false, validationSuite: "off",
                promotable: false
            )
        case "workspace":
            return PodConfig(
                agentMode: .interactive, output: .branch, validate: false, validationSuite: "off",
                promotable: true
            )
        default:
            return PodConfig(
                agentMode: .auto, output: .pr, validate: true, validationSuite: "full",
                promotable: false
            )
        }
    }

    /// Derive a legacy `outputMode` value from a PodConfig (best-effort for display).
    public var legacyOutputMode: OutputMode {
        if agentMode == .interactive { return .workspace }
        if output == .artifact { return .artifact }
        return .pr
    }

    /// Whether this pod is promotable to a different agent mode from its current state.
    public var isPromotable: Bool {
        agentMode == .interactive && promotable
    }

    public var summaryLabel: String {
        "\(agentMode.label) · \(output.label) · \(validationSuite)"
    }
}
