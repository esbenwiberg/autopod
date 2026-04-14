import Foundation

// MARK: - Profile (mirrors packages/shared/src/types/profile.ts)

public struct Profile: Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var repoUrl: String
    public var defaultBranch: String
    public var template: StackTemplate
    public var buildCommand: String
    public var startCommand: String
    public var testCommand: String?
    public var healthPath: String
    public var healthTimeout: Int
    public var buildTimeout: Int
    public var testTimeout: Int
    public var maxValidationAttempts: Int
    public var defaultModel: String
    public var defaultRuntime: RuntimeType
    public var executionTarget: ExecutionTarget
    public var modelProvider: ModelProvider
    public var prProvider: PRProvider
    public var customInstructions: String?
    public var containerMemoryGb: Double?

    // Issue watcher
    public var issueWatcherEnabled: Bool
    public var issueWatcherLabelPrefix: String

    // Credentials — `hasXxxPat` reflects API state; `xxxPat` holds new values being set
    public var hasGithubPat: Bool
    public var hasAdoPat: Bool
    public var hasRegistryPat: Bool
    public var githubPat: String?
    public var adoPat: String?
    public var registryPat: String?

    // Network policy
    public var networkEnabled: Bool
    public var networkMode: NetworkPolicyMode
    public var allowedHosts: [String]
    public var allowPackageManagers: Bool

    // Private registries
    public var privateRegistries: [PrivateRegistry]

    // Smoke pages
    public var smokePages: [SmokePage]

    // Injected items
    public var mcpServers: [InjectedMcpServer]
    public var claudeMdSections: [InjectedClaudeMdSection]
    public var skills: [InjectedSkill]

    // Escalation
    public var escalationAskHuman: Bool
    public var escalationAskAiEnabled: Bool
    public var escalationAskAiModel: String
    public var escalationAskAiMaxCalls: Int
    public var escalationAdvisorEnabled: Bool
    public var escalationAutoPauseAfter: Int
    public var escalationHumanResponseTimeout: Int

    // Output & inheritance
    public var outputMode: OutputMode
    public var extendsProfile: String?
    /// Profile to use when spawning worker sessions from a workspace using this profile
    public var workerProfile: String?

    // Warm image (read-only, set by daemon)
    public var warmImageTag: String?
    public var warmImageBuiltAt: String?

    // Action policy
    public var actionPolicyEnabled: Bool
    public var actionEnabledGroups: Set<ActionGroup>
    public var actionEnabledActions: Set<String>
    public var actionOverrides: [ActionOverride]
    public var actionSanitizationPreset: SanitizationPreset
    public var actionSanitizationAllowedDomains: [String]
    public var actionQuarantineEnabled: Bool
    public var actionQuarantineThreshold: Double
    public var actionQuarantineBlockThreshold: Double
    public var actionQuarantineOnBlock: QuarantineOnBlock

    // Provider credentials (read-only indicator)
    public var providerCredentialsType: String?

    // Convenience counts (for badges / list views)
    public var mcpServerCount: Int { mcpServers.count }
    public var claudeMdSectionCount: Int { claudeMdSections.count }
    public var skillCount: Int { skills.count }

    public var version: Int
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        name: String, repoUrl: String, defaultBranch: String = "main",
        template: StackTemplate = .node22,
        buildCommand: String = "npm run build", startCommand: String = "npm start",
        testCommand: String? = nil,
        healthPath: String = "/", healthTimeout: Int = 120,
        buildTimeout: Int = 300, testTimeout: Int = 600,
        maxValidationAttempts: Int = 3,
        defaultModel: String = "opus", defaultRuntime: RuntimeType = .claude,
        executionTarget: ExecutionTarget = .local,
        modelProvider: ModelProvider = .anthropic, prProvider: PRProvider = .github,
        customInstructions: String? = nil, containerMemoryGb: Double? = nil,
        issueWatcherEnabled: Bool = false, issueWatcherLabelPrefix: String = "autopod",
        hasGithubPat: Bool = false, hasAdoPat: Bool = false, hasRegistryPat: Bool = false,
        githubPat: String? = nil, adoPat: String? = nil, registryPat: String? = nil,
        networkEnabled: Bool = false, networkMode: NetworkPolicyMode = .restricted,
        allowedHosts: [String] = [], allowPackageManagers: Bool = false,
        privateRegistries: [PrivateRegistry] = [], smokePages: [SmokePage] = [],
        mcpServers: [InjectedMcpServer] = [],
        claudeMdSections: [InjectedClaudeMdSection] = [],
        skills: [InjectedSkill] = [],
        escalationAskHuman: Bool = true,
        escalationAskAiEnabled: Bool = true, escalationAskAiModel: String = "sonnet",
        escalationAskAiMaxCalls: Int = 3, escalationAdvisorEnabled: Bool = false,
        escalationAutoPauseAfter: Int = 1, escalationHumanResponseTimeout: Int = 3600,
        outputMode: OutputMode = .pr, extendsProfile: String? = nil,
        workerProfile: String? = nil,
        warmImageTag: String? = nil, warmImageBuiltAt: String? = nil,
        actionPolicyEnabled: Bool = false,
        actionEnabledGroups: Set<ActionGroup> = [],
        actionEnabledActions: Set<String> = [],
        actionOverrides: [ActionOverride] = [],
        actionSanitizationPreset: SanitizationPreset = .standard,
        actionSanitizationAllowedDomains: [String] = [],
        actionQuarantineEnabled: Bool = false,
        actionQuarantineThreshold: Double = 0.5,
        actionQuarantineBlockThreshold: Double = 0.8,
        actionQuarantineOnBlock: QuarantineOnBlock = .askHuman,
        providerCredentialsType: String? = nil,
        version: Int = 1,
        createdAt: Date = Date(), updatedAt: Date = Date()
    ) {
        self.name = name; self.repoUrl = repoUrl; self.defaultBranch = defaultBranch
        self.template = template; self.buildCommand = buildCommand
        self.startCommand = startCommand; self.testCommand = testCommand
        self.healthPath = healthPath; self.healthTimeout = healthTimeout
        self.buildTimeout = buildTimeout; self.testTimeout = testTimeout
        self.maxValidationAttempts = maxValidationAttempts
        self.defaultModel = defaultModel; self.defaultRuntime = defaultRuntime
        self.executionTarget = executionTarget; self.modelProvider = modelProvider
        self.prProvider = prProvider; self.customInstructions = customInstructions
        self.containerMemoryGb = containerMemoryGb
        self.issueWatcherEnabled = issueWatcherEnabled
        self.issueWatcherLabelPrefix = issueWatcherLabelPrefix
        self.hasGithubPat = hasGithubPat; self.hasAdoPat = hasAdoPat
        self.hasRegistryPat = hasRegistryPat
        self.githubPat = githubPat; self.adoPat = adoPat; self.registryPat = registryPat
        self.networkEnabled = networkEnabled; self.networkMode = networkMode
        self.allowedHosts = allowedHosts; self.allowPackageManagers = allowPackageManagers
        self.privateRegistries = privateRegistries
        self.smokePages = smokePages
        self.mcpServers = mcpServers; self.claudeMdSections = claudeMdSections
        self.skills = skills
        self.escalationAskHuman = escalationAskHuman
        self.escalationAskAiEnabled = escalationAskAiEnabled
        self.escalationAskAiModel = escalationAskAiModel
        self.escalationAskAiMaxCalls = escalationAskAiMaxCalls
        self.escalationAdvisorEnabled = escalationAdvisorEnabled
        self.escalationAutoPauseAfter = escalationAutoPauseAfter
        self.escalationHumanResponseTimeout = escalationHumanResponseTimeout
        self.outputMode = outputMode; self.extendsProfile = extendsProfile
        self.workerProfile = workerProfile
        self.warmImageTag = warmImageTag; self.warmImageBuiltAt = warmImageBuiltAt
        self.actionPolicyEnabled = actionPolicyEnabled
        self.actionEnabledGroups = actionEnabledGroups
        self.actionEnabledActions = actionEnabledActions
        self.actionOverrides = actionOverrides
        self.actionSanitizationPreset = actionSanitizationPreset
        self.actionSanitizationAllowedDomains = actionSanitizationAllowedDomains
        self.actionQuarantineEnabled = actionQuarantineEnabled
        self.actionQuarantineThreshold = actionQuarantineThreshold
        self.actionQuarantineBlockThreshold = actionQuarantineBlockThreshold
        self.actionQuarantineOnBlock = actionQuarantineOnBlock
        self.providerCredentialsType = providerCredentialsType
        self.version = version
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

// MARK: - Enums

public enum StackTemplate: String, CaseIterable, Sendable {
    case node22, node22Pw = "node22-pw", dotnet9, dotnet10, python312, custom

    public var label: String {
        switch self {
        case .node22:    "Node 22"
        case .node22Pw:  "Node 22 + Playwright"
        case .dotnet9:   ".NET 9"
        case .dotnet10:  ".NET 10"
        case .python312: "Python 3.12"
        case .custom:    "Custom"
        }
    }
}

public enum RuntimeType: String, CaseIterable, Sendable {
    case claude, codex, copilot
}

public enum ExecutionTarget: String, CaseIterable, Sendable {
    case local, aci
    public var label: String {
        switch self {
        case .local: "Local (Docker)"
        case .aci:   "Azure Container Instances"
        }
    }
}

public enum ModelProvider: String, CaseIterable, Sendable {
    case anthropic, max, foundry, copilot
}

public enum PRProvider: String, CaseIterable, Sendable {
    case github, ado
    public var label: String {
        switch self {
        case .github: "GitHub"
        case .ado:    "Azure DevOps"
        }
    }
}

public enum ActionGroup: String, CaseIterable, Sendable, Hashable {
    case githubIssues = "github-issues"
    case githubPrs = "github-prs"
    case githubCode = "github-code"
    case adoWorkitems = "ado-workitems"
    case adoPrs = "ado-prs"
    case adoCode = "ado-code"
    case azureLogs = "azure-logs"
    case custom

    public var label: String {
        switch self {
        case .githubIssues:  "GitHub Issues"
        case .githubPrs:     "GitHub PRs"
        case .githubCode:    "GitHub Code"
        case .adoWorkitems:  "ADO Work Items"
        case .adoPrs:        "ADO PRs"
        case .adoCode:       "ADO Code"
        case .azureLogs:     "Azure Logs"
        case .custom:        "Custom"
        }
    }
}

public enum SanitizationPreset: String, CaseIterable, Sendable {
    case strict, standard, relaxed
    public var label: String { rawValue.capitalized }
    public var description: String {
        switch self {
        case .strict:   "Aggressive PII stripping — blocks most external data"
        case .standard: "Balanced — strips obvious PII, allows structured data"
        case .relaxed:  "Minimal filtering — trusts action responses"
        }
    }
}

public enum QuarantineOnBlock: String, CaseIterable, Sendable {
    case skip
    case askHuman = "ask_human"
    public var label: String {
        switch self {
        case .skip:     "Skip (discard)"
        case .askHuman: "Ask Human"
        }
    }
}

/// Lightweight catalog entry for the action picker UI.
public struct ActionCatalogItem: Identifiable, Hashable, Sendable {
    public var id: String { name }
    public let name: String
    public let description: String
    public let group: String

    public init(name: String, description: String, group: String) {
        self.name = name
        self.description = description
        self.group = group
    }
}

public struct ActionOverride: Identifiable, Hashable, Sendable {
    public var id: UUID = UUID()
    public var action: String
    public var allowedResources: [String]
    public var requiresApproval: Bool
    public var disabled: Bool

    public init(
        action: String = "",
        allowedResources: [String] = [],
        requiresApproval: Bool = false,
        disabled: Bool = false
    ) {
        self.action = action
        self.allowedResources = allowedResources
        self.requiresApproval = requiresApproval
        self.disabled = disabled
    }
}

public enum NetworkPolicyMode: String, CaseIterable, Sendable {
    case allowAll = "allow-all"
    case denyAll = "deny-all"
    case restricted

    public var label: String {
        switch self {
        case .allowAll:   "Allow All"
        case .denyAll:    "Deny All"
        case .restricted: "Restricted"
        }
    }
}

public struct PrivateRegistry: Sendable {
    public var type: RegistryType
    public var url: String
    public var scope: String?
    public init(type: RegistryType, url: String, scope: String? = nil) {
        self.type = type; self.url = url; self.scope = scope
    }
}

public enum RegistryType: String, CaseIterable, Sendable {
    case npm, nuget
}

public struct SmokePage: Sendable {
    public var path: String
    public init(path: String) { self.path = path }
}

public struct InjectedMcpServer: Sendable {
    public var name: String
    public var url: String
    public var description: String?
    public init(name: String = "", url: String = "", description: String? = nil) {
        self.name = name; self.url = url; self.description = description
    }
}

public struct InjectedClaudeMdSection: Sendable {
    public var heading: String
    public var content: String
    public init(heading: String = "", content: String = "") {
        self.heading = heading; self.content = content
    }
}

public struct InjectedSkill: Sendable {
    public var name: String
    public var description: String?
    public init(name: String = "", description: String? = nil) {
        self.name = name; self.description = description
    }
}

// MARK: - Mock profiles

public enum MockProfiles: Sendable {
    public static let all: [Profile] = [myApp, webapp, backend]

    public static let myApp = Profile(
        name: "my-app",
        repoUrl: "https://github.com/org/my-app.git",
        template: .node22Pw,
        buildCommand: "pnpm build",
        startCommand: "pnpm start",
        testCommand: "pnpm test",
        healthPath: "/api/health",
        defaultModel: "opus",
        hasGithubPat: true,
        networkEnabled: true, networkMode: .restricted,
        allowedHosts: ["api.stripe.com", "auth.google.com"],
        smokePages: [SmokePage(path: "/"), SmokePage(path: "/login"), SmokePage(path: "/dashboard")],
        mcpServers: [InjectedMcpServer(name: "browser", url: "http://localhost:9222", description: "Chrome DevTools")],
        claudeMdSections: [
            InjectedClaudeMdSection(heading: "Coding Standards", content: "Use strict TypeScript."),
            InjectedClaudeMdSection(heading: "Testing", content: "Always write tests.")
        ],
        skills: [
            InjectedSkill(name: "deploy", description: "Deploy to staging"),
            InjectedSkill(name: "lint", description: "Run linter"),
            InjectedSkill(name: "db-migrate", description: "Run database migrations")
        ],
        escalationAskHuman: true,
        escalationAskAiEnabled: true, escalationAskAiModel: "sonnet",
        escalationAskAiMaxCalls: 5,
        escalationAutoPauseAfter: 2, escalationHumanResponseTimeout: 7200,
        actionPolicyEnabled: true,
        actionEnabledGroups: [.githubIssues, .githubPrs],
        actionOverrides: [
            ActionOverride(action: "read_issue", allowedResources: ["org/*"], requiresApproval: false),
            ActionOverride(action: "read_pr", allowedResources: ["org/my-app"], requiresApproval: true),
        ],
        actionSanitizationPreset: .standard,
        actionQuarantineEnabled: true
    )

    public static let webapp = Profile(
        name: "webapp",
        repoUrl: "https://github.com/org/webapp.git",
        template: .node22,
        buildCommand: "npm run build",
        startCommand: "npm start",
        healthPath: "/",
        defaultModel: "sonnet",
        smokePages: [SmokePage(path: "/"), SmokePage(path: "/about")]
    )

    public static let backend = Profile(
        name: "backend",
        repoUrl: "https://github.com/org/backend.git",
        template: .dotnet10,
        buildCommand: "dotnet build",
        startCommand: "dotnet run",
        testCommand: "dotnet test",
        healthPath: "/health",
        defaultModel: "opus",
        prProvider: .ado,
        hasAdoPat: true, hasRegistryPat: true,
        networkEnabled: true, networkMode: .restricted,
        privateRegistries: [PrivateRegistry(type: .nuget, url: "https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json")]
    )
}
