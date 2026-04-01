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

    // Credentials (display masked, edit separately)
    public var hasGithubPat: Bool
    public var hasAdoPat: Bool
    public var hasRegistryPat: Bool

    // Network policy
    public var networkEnabled: Bool
    public var networkMode: NetworkPolicyMode
    public var allowedHosts: [String]

    // Private registries
    public var privateRegistries: [PrivateRegistry]

    // Smoke pages
    public var smokePages: [SmokePage]

    // Counts for injected items (shown as badges, edited in sub-views)
    public var mcpServerCount: Int
    public var claudeMdSectionCount: Int
    public var skillCount: Int

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
        hasGithubPat: Bool = false, hasAdoPat: Bool = false, hasRegistryPat: Bool = false,
        networkEnabled: Bool = false, networkMode: NetworkPolicyMode = .restricted,
        allowedHosts: [String] = [],
        privateRegistries: [PrivateRegistry] = [], smokePages: [SmokePage] = [],
        mcpServerCount: Int = 0, claudeMdSectionCount: Int = 0, skillCount: Int = 0,
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
        self.hasGithubPat = hasGithubPat; self.hasAdoPat = hasAdoPat
        self.hasRegistryPat = hasRegistryPat
        self.networkEnabled = networkEnabled; self.networkMode = networkMode
        self.allowedHosts = allowedHosts; self.privateRegistries = privateRegistries
        self.smokePages = smokePages
        self.mcpServerCount = mcpServerCount; self.claudeMdSectionCount = claudeMdSectionCount
        self.skillCount = skillCount
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
        mcpServerCount: 1, claudeMdSectionCount: 2, skillCount: 3
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
