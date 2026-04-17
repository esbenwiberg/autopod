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

public struct PodConfig: Sendable, Equatable {
    public var agentMode: AgentMode
    public var output: OutputTarget
    /// Run full build/smoke/review before completing.
    public var validate: Bool
    /// Allow promoting this session to a different mode later.
    public var promotable: Bool

    public init(
        agentMode: AgentMode = .auto,
        output: OutputTarget = .pr,
        validate: Bool = true,
        promotable: Bool = false
    ) {
        self.agentMode = agentMode
        self.output = output
        self.validate = validate
        self.promotable = promotable
    }

    /// Map a legacy `outputMode` string (pr/artifact/workspace) to a PodConfig.
    public static func fromLegacy(_ outputMode: String) -> PodConfig {
        switch outputMode {
        case "pr":
            return PodConfig(agentMode: .auto, output: .pr, validate: true, promotable: false)
        case "artifact":
            return PodConfig(agentMode: .auto, output: .artifact, validate: false, promotable: false)
        case "workspace":
            return PodConfig(agentMode: .interactive, output: .branch, validate: false, promotable: true)
        default:
            return PodConfig(agentMode: .auto, output: .pr, validate: true, promotable: false)
        }
    }

    /// Derive a legacy `outputMode` value from a PodConfig (best-effort for display).
    public var legacyOutputMode: OutputMode {
        if agentMode == .interactive { return .workspace }
        if output == .artifact { return .artifact }
        return .pr
    }

    /// Whether this session is promotable to a different agent mode from its current state.
    public var isPromotable: Bool {
        agentMode == .interactive && promotable
    }

    public var summaryLabel: String {
        "\(agentMode.label) · \(output.label)"
    }
}
