import AutopodClient
import Foundation

enum ConfigurationEditorArea: String, Identifiable, CaseIterable {
    case composition = "Composition"
    case execution = "Execution"
    case network = "Network"
    case access = "Access & worker"
    case main = "Main agent"
    case reviewer = "Reviewer"
    case advisor = "Advisor"
    case failover = "Failover"
    case run = "Run & deliver"
    case validation = "Validation"
    case budgets = "Budgets"
    case security = "Security scans"
    case escalation = "Escalation"
    case delivery = "Delivery details"
    case runtime = "Runtime"
    case software = "Software"
    case sidecars = "Sidecars"
    case capabilities = "Capabilities"
    case instructions = "Instructions"
    case integrations = "Skills & MCP"
    case rules = "Access rules"
    case overview = "Overview"
    case setups = "Project setups"
    case trust = "Trust & identity"
    case advanced = "Complete JSON"
    var id: String { rawValue }
    func helpTopicID(for kind: ConfigurationKind) -> String { "\(kind.rawValue).sections.\(String(describing: self))" }
    func hasDedicatedHelp(for kind: ConfigurationKind) -> Bool {
        (kind == .ai && self == .failover) || (kind == .workflow && self == .validation) || (kind == .toolPack && self == .instructions)
    }
    static func areas(for kind: ConfigurationKind) -> [Self] {
        switch kind {
        case .profile: [.composition, .execution, .network, .sidecars, .access, .advanced]
        case .ai: [.main, .reviewer, .advisor, .failover, .advanced]
        case .workflow: [.run, .validation, .security, .budgets, .escalation, .delivery, .advanced]
        case .environment: [.runtime, .software, .sidecars, .capabilities, .advanced]
        case .githubAccess: [.rules, .advanced]
        case .toolPack: [.software, .instructions, .integrations, .capabilities, .advanced]
        case .repository: [.overview, .setups, .trust, .advanced]
        case .packageFeed: [.overview, .advanced]
        }
    }
}

func configurationReferences(_ value: ConfigurationJSON, id: String) -> Bool {
    switch value {
    case .string(let text): text == id
    case .array(let values): values.contains { configurationReferences($0, id: id) }
    case .object(let fields): fields.values.contains { configurationReferences($0, id: id) }
    default: false
    }
}

/// Editor defaults are presentation only: opening old JSON must not insert Advisor.
enum ConfigurationAdvisorSelection {
    static func mode(_ payload: [String: ConfigurationJSON]) -> String {
        payload["advisor"]?["mode"]?.string ?? "follow-reviewer"
    }
    static func value(mode: String, initialRoute: [String: ConfigurationJSON]) -> ConfigurationJSON {
        .object(mode == "independent"
            ? ["mode": .string(mode), "route": .object(initialRoute)]
            : ["mode": .string(mode)])
    }
}
