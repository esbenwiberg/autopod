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
    public var reviewerModel: String
    public var defaultRuntime: RuntimeType
    public var executionTarget: ExecutionTarget
    public var modelProvider: ModelProvider
    public var prProvider: PRProvider
    public var customInstructions: String?
    public var containerMemoryGb: Double?
    public var branchPrefix: String
    public var hasWebUi: Bool

    // Token budget
    public var tokenBudget: Int?
    public var tokenBudgetPolicy: TokenBudgetPolicy
    public var tokenBudgetWarnAt: Double
    public var maxBudgetExtensions: Int?

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

    // Pod config (orthogonal axes) + back-compat single-enum legacy output mode
    public var pod: PodConfig
    public var extendsProfile: String?
    /// Profile to use when spawning worker pods from a workspace using this profile
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

    // PIM activations (security allowlist for Azure PIM actions)
    public var pimActivations: [PimActivationEntry]

    // Sandbox / sidecars
    /// Gate for privileged sidecars (currently Dagger engine). When true, this
    /// profile is allowed to spawn sidecars that run privileged. Only internal
    /// repos with reviewed PRs should set this.
    public var trustedSource: Bool
    /// Opaque sidecar config preserved on round-trip. Editor UI covers only
    /// the trustedSource toggle + testPipeline in v1; sidecars.dagger is still
    /// edited via CLI / direct profile JSON.
    public var sidecars: SidecarsSnapshot?

    // Test pipeline (ADO)
    public var testPipeline: TestPipelineConfig?

    // Provider credentials (read-only indicator)
    public var providerCredentialsType: String?

    /// Backward-compat legacy output mode derived from `pod`.
    public var outputMode: OutputMode {
        get { pod.legacyOutputMode }
        set { pod = PodConfig.fromLegacy(newValue.rawValue) }
    }

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
        defaultModel: String = "opus", reviewerModel: String = "sonnet",
        defaultRuntime: RuntimeType = .claude,
        executionTarget: ExecutionTarget = .local,
        modelProvider: ModelProvider = .anthropic, prProvider: PRProvider = .github,
        customInstructions: String? = nil, containerMemoryGb: Double? = nil,
        branchPrefix: String = "autopod/", hasWebUi: Bool = true,
        tokenBudget: Int? = nil, tokenBudgetPolicy: TokenBudgetPolicy = .soft,
        tokenBudgetWarnAt: Double = 0.8, maxBudgetExtensions: Int? = nil,
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
        pod: PodConfig = PodConfig(),
        extendsProfile: String? = nil,
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
        pimActivations: [PimActivationEntry] = [],
        trustedSource: Bool = false,
        sidecars: SidecarsSnapshot? = nil,
        testPipeline: TestPipelineConfig? = nil,
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
        self.defaultModel = defaultModel; self.reviewerModel = reviewerModel
        self.defaultRuntime = defaultRuntime
        self.executionTarget = executionTarget; self.modelProvider = modelProvider
        self.prProvider = prProvider; self.customInstructions = customInstructions
        self.containerMemoryGb = containerMemoryGb
        self.branchPrefix = branchPrefix; self.hasWebUi = hasWebUi
        self.tokenBudget = tokenBudget; self.tokenBudgetPolicy = tokenBudgetPolicy
        self.tokenBudgetWarnAt = tokenBudgetWarnAt; self.maxBudgetExtensions = maxBudgetExtensions
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
        self.pod = pod
        self.extendsProfile = extendsProfile
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
        self.pimActivations = pimActivations
        self.trustedSource = trustedSource
        self.sidecars = sidecars
        self.testPipeline = testPipeline
        self.providerCredentialsType = providerCredentialsType
        self.version = version
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

// MARK: - Sandbox & test-pipeline domain types

/// Opaque snapshot of the profile's `sidecars` config. Preserved verbatim so
/// write operations don't wipe out fields the editor UI doesn't surface yet.
public struct SidecarsSnapshot: Sendable, Equatable {
    public var dagger: DaggerSidecarSnapshot?
    public init(dagger: DaggerSidecarSnapshot? = nil) { self.dagger = dagger }
}

public struct DaggerSidecarSnapshot: Sendable, Equatable {
    public var enabled: Bool
    public var engineImageDigest: String
    public var engineVersion: String
    public var enginePort: Int?
    public var memoryGb: Double?
    public var cpus: Double?
    public var storageGb: Double?

    public init(
        enabled: Bool,
        engineImageDigest: String,
        engineVersion: String,
        enginePort: Int? = nil,
        memoryGb: Double? = nil,
        cpus: Double? = nil,
        storageGb: Double? = nil
    ) {
        self.enabled = enabled
        self.engineImageDigest = engineImageDigest
        self.engineVersion = engineVersion
        self.enginePort = enginePort
        self.memoryGb = memoryGb
        self.cpus = cpus
        self.storageGb = storageGb
    }
}

public struct TestPipelineConfig: Sendable, Equatable {
    public var enabled: Bool
    public var testRepo: String
    public var testPipelineId: Int
    public var rateLimitPerHour: Int?
    public var branchPrefix: String?

    public init(
        enabled: Bool = false,
        testRepo: String = "",
        testPipelineId: Int = 0,
        rateLimitPerHour: Int? = nil,
        branchPrefix: String? = nil
    ) {
        self.enabled = enabled
        self.testRepo = testRepo
        self.testPipelineId = testPipelineId
        self.rateLimitPerHour = rateLimitPerHour
        self.branchPrefix = branchPrefix
    }
}

// MARK: - Enums

public enum StackTemplate: String, CaseIterable, Sendable {
    case node22, node22Pw = "node22-pw", dotnet9, dotnet10, dotnet10Go = "dotnet10-go",
         python312, pythonNode = "python-node", go124, go124Pw = "go124-pw", custom

    public var label: String {
        switch self {
        case .node22:       "Node 22"
        case .node22Pw:     "Node 22 + Playwright"
        case .dotnet9:      ".NET 9"
        case .dotnet10:     ".NET 10"
        case .dotnet10Go:   ".NET 10 + Go"
        case .python312:    "Python 3.12"
        case .pythonNode:   "Python + Node"
        case .go124:        "Go 1.24"
        case .go124Pw:      "Go 1.24 + Playwright"
        case .custom:       "Custom"
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

public enum TokenBudgetPolicy: String, CaseIterable, Sendable {
    case soft, hard
    public var label: String { rawValue.capitalized }
    public var description: String {
        switch self {
        case .soft: "Pause for approval when budget is exceeded"
        case .hard: "Fail immediately when budget is exceeded"
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
    case adoTestPipeline = "ado-test-pipeline"
    case azureLogs = "azure-logs"
    case azurePim = "azure-pim"
    case custom

    public var label: String {
        switch self {
        case .githubIssues:     "GitHub Issues"
        case .githubPrs:        "GitHub PRs"
        case .githubCode:       "GitHub Code"
        case .adoWorkitems:     "ADO Work Items"
        case .adoPrs:           "ADO PRs"
        case .adoCode:          "ADO Code"
        case .adoTestPipeline:  "ADO Test Pipeline"
        case .azureLogs:        "Azure Logs"
        case .azurePim:         "Azure PIM"
        case .custom:           "Custom"
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

public enum PimActivationType: String, CaseIterable, Sendable {
    case group
    case rbacRole = "rbac_role"

    public var label: String {
        switch self {
        case .group:    "Entra Group"
        case .rbacRole: "RBAC Role"
        }
    }
}

public struct PimActivationEntry: Identifiable, Sendable {
    public var id: UUID = UUID()
    public var type: PimActivationType
    public var groupId: String
    public var scope: String
    public var roleDefinitionId: String
    public var displayName: String?
    public var duration: String?
    public var justification: String?

    public init(
        type: PimActivationType = .rbacRole,
        groupId: String = "",
        scope: String = "",
        roleDefinitionId: String = "",
        displayName: String? = nil,
        duration: String? = nil,
        justification: String? = nil
    ) {
        self.type = type
        self.groupId = groupId
        self.scope = scope
        self.roleDefinitionId = roleDefinitionId
        self.displayName = displayName
        self.duration = duration
        self.justification = justification
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
    /// Source discriminator round-tripped to the daemon. Shapes:
    ///   local  → ["type": "local", "path": "<absolute or cwd-relative path>"]
    ///   github → ["type": "github", "repo": "owner/name", "path": "...", "ref": "main", "token": "..."]
    public var source: [String: String]?
    public init(name: String = "", description: String? = nil, source: [String: String]? = nil) {
        self.name = name
        self.description = description
        // Default to an empty `local` source so the editor has something to display.
        self.source = source ?? ["type": "local", "path": ""]
    }

    // MARK: - UI bindings

    public var sourceType: String {
        get { source?["type"] ?? "local" }
        set {
            var s = source ?? [:]
            s["type"] = newValue
            // Clear keys that don't apply to the new type so we don't leak stale values.
            if newValue == "local" {
                s.removeValue(forKey: "repo")
                s.removeValue(forKey: "ref")
                s.removeValue(forKey: "token")
            } else if newValue == "github" {
                // Keep `path` — it is valid for both types.
            }
            source = s
        }
    }

    public var localPath: String {
        get { source?["path"] ?? "" }
        set {
            var s = source ?? ["type": "local"]
            s["path"] = newValue
            source = s
        }
    }

    public var githubRepo: String {
        get { source?["repo"] ?? "" }
        set {
            var s = source ?? ["type": "github"]
            s["repo"] = newValue
            source = s
        }
    }

    public var githubPath: String {
        get { source?["path"] ?? "" }
        set {
            var s = source ?? ["type": "github"]
            if newValue.isEmpty {
                s.removeValue(forKey: "path")
            } else {
                s["path"] = newValue
            }
            source = s
        }
    }

    public var githubRef: String {
        get { source?["ref"] ?? "" }
        set {
            var s = source ?? ["type": "github"]
            if newValue.isEmpty {
                s.removeValue(forKey: "ref")
            } else {
                s["ref"] = newValue
            }
            source = s
        }
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
