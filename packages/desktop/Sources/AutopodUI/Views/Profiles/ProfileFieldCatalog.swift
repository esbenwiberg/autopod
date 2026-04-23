import Foundation

/// Declarative catalog of every Profile property that can be overridden on
/// a derived profile. Drives the "Add override…" menu and the section-grouped
/// rendering of the overrides view. Keep this in sync with `Profile.swift`
/// and `packages/shared/src/types/profile.ts`.
public enum ProfileOverrideFieldSection: String, CaseIterable, Sendable {
    case general     = "General"
    case buildRun    = "Build & Run"
    case agent       = "Agent"
    case providers   = "Providers"
    case escalation  = "Escalation"
    case container   = "Container"
    case network     = "Network & Security"
    case actions     = "Actions"
    case issueWatcher = "Issue Watcher"
    case validation  = "Validation"
    case sandbox     = "Sandbox & Test Pipeline"
    case credentials = "Credentials"
    case injections  = "Injections"
}

/// A single overridable property. `key` must match the Profile JSON field
/// name as seen by the daemon (what `ProfileMapper.mapToFields` emits and
/// what the PATCH endpoint expects). `label` is human-readable; `section`
/// drives grouping in the Add menu; `help` is shown on the card.
public struct ProfileOverrideField: Hashable, Identifiable, Sendable {
    public let key: String
    public let label: String
    public let section: ProfileOverrideFieldSection
    public let help: String
    public var id: String { key }
}

public enum ProfileOverrideCatalog {
    /// Ordered list of every field a derived profile can override. New
    /// fields should be added here AND a card renderer written in
    /// `ProfileEditorView+Overrides.swift`.
    public static let all: [ProfileOverrideField] = [
        // MARK: General
        .init(
            key: "repoUrl",
            label: "Repository URL",
            section: .general,
            help: "Git clone URL for this profile's source."
        ),
        .init(
            key: "defaultBranch",
            label: "Default Branch",
            section: .general,
            help: "Base branch for worktrees."
        ),
        .init(
            key: "branchPrefix",
            label: "Branch Prefix",
            section: .general,
            help: "Prefix for auto-generated pod branches."
        ),
        .init(
            key: "template",
            label: "Template",
            section: .general,
            help: "Container image / toolchain."
        ),
        .init(
            key: "pod",
            label: "Pod Defaults",
            section: .general,
            help: "Agent mode, output target, validate, promotable."
        ),
        .init(
            key: "workerProfile",
            label: "Worker Profile",
            section: .general,
            help: "Profile used when spawning worker pods from a workspace pod."
        ),

        // MARK: Build & Run
        .init(
            key: "buildCommand",
            label: "Build Command",
            section: .buildRun,
            help: "Runs after repo clone. Must exit 0 for validation to proceed."
        ),
        .init(
            key: "startCommand",
            label: "Start Command",
            section: .buildRun,
            help: "Starts the app for health checks and smoke testing."
        ),
        .init(
            key: "testCommand",
            label: "Test Command",
            section: .buildRun,
            help: "Runs after build. Leave empty to skip."
        ),
        .init(
            key: "healthPath",
            label: "Health Path",
            section: .buildRun,
            help: "HTTP path polled to confirm the app is ready."
        ),
        .init(
            key: "healthTimeout",
            label: "Health Timeout",
            section: .buildRun,
            help: "Seconds to wait for the health check to succeed."
        ),
        .init(
            key: "buildTimeout",
            label: "Build Timeout",
            section: .buildRun,
            help: "Seconds to wait for the build command."
        ),
        .init(
            key: "testTimeout",
            label: "Test Timeout",
            section: .buildRun,
            help: "Seconds to wait for the test command."
        ),

        // MARK: Agent
        .init(
            key: "defaultModel",
            label: "Default Model",
            section: .agent,
            help: "AI model name (e.g. `opus`, `sonnet`)."
        ),
        .init(
            key: "defaultRuntime",
            label: "Default Runtime",
            section: .agent,
            help: "Claude / Codex / Copilot."
        ),
        .init(
            key: "customInstructions",
            label: "Custom Instructions",
            section: .agent,
            help: "Appended to the container CLAUDE.md."
        ),

        // MARK: Providers
        .init(
            key: "modelProvider",
            label: "Model Provider",
            section: .providers,
            help: "anthropic / max / foundry / copilot. Credentials are tied to this choice."
        ),
        .init(
            key: "prProvider",
            label: "PR Provider",
            section: .providers,
            help: "Where PRs are created — GitHub or Azure DevOps."
        ),

        // MARK: Escalation
        .init(
            key: "escalation",
            label: "Escalation",
            section: .escalation,
            help: "Ask-human / ask-AI / advisor / auto-pause behavior."
        ),
        .init(
            key: "tokenBudget",
            label: "Token Budget",
            section: .escalation,
            help: "Max tokens per session. Null = unlimited."
        ),
        .init(
            key: "tokenBudgetPolicy",
            label: "Budget Policy",
            section: .escalation,
            help: "soft = pause for approval, hard = fail immediately."
        ),
        .init(
            key: "tokenBudgetWarnAt",
            label: "Budget Warn At",
            section: .escalation,
            help: "Fraction of budget at which to emit a warning."
        ),
        .init(
            key: "maxBudgetExtensions",
            label: "Max Budget Extensions",
            section: .escalation,
            help: "How many times the user may approve an extension. Null = unlimited."
        ),

        // MARK: Container
        .init(
            key: "executionTarget",
            label: "Execution Target",
            section: .container,
            help: "local Docker or Azure Container Instances."
        ),
        .init(
            key: "containerMemoryGb",
            label: "Memory Limit (GB)",
            section: .container,
            help: "Container memory cap. Null = Docker default."
        ),

        // MARK: Network & Security
        .init(
            key: "networkPolicy",
            label: "Network Policy",
            section: .network,
            help: "Firewall mode + allowlist of hosts the container can reach."
        ),

        // MARK: Actions
        .init(
            key: "actionPolicy",
            label: "Action Policy",
            section: .actions,
            help: "Which action groups the agent can call, sanitization, quarantine."
        ),
        .init(
            key: "pimActivations",
            label: "PIM Activations",
            section: .actions,
            help: "Azure PIM groups and roles auto-activated for pods."
        ),

        // MARK: Issue Watcher
        .init(
            key: "issueWatcherEnabled",
            label: "Issue Watcher Enabled",
            section: .issueWatcher,
            help: "Automatically pick up issues labeled with the prefix."
        ),
        .init(
            key: "issueWatcherLabelPrefix",
            label: "Issue Label Prefix",
            section: .issueWatcher,
            help: "Trigger label prefix (default `autopod`)."
        ),

        // MARK: Validation
        .init(
            key: "hasWebUi",
            label: "Has Web UI",
            section: .validation,
            help: "When false, browser-based checks are skipped."
        ),
        .init(
            key: "maxValidationAttempts",
            label: "Max Validation Attempts",
            section: .validation,
            help: "Retry budget for the full validation pipeline."
        ),
        .init(
            key: "smokePages",
            label: "Smoke Pages",
            section: .validation,
            help: "Pages loaded after start to verify the app renders."
        ),

        // MARK: Sandbox & Test Pipeline
        .init(
            key: "trustedSource",
            label: "Trusted Source",
            section: .sandbox,
            help: "Gate for privileged sidecars (Dagger engine). Only enable for internal repos with reviewed PRs."
        ),
        .init(
            key: "sidecars",
            label: "Sidecars",
            section: .sandbox,
            help: "Per-type sidecar config (currently: Dagger engine digest/version). Edited in the Sandbox & Test Pipeline tab."
        ),
        .init(
            key: "testPipeline",
            label: "Test Pipeline",
            section: .sandbox,
            help: "ADO pipeline the agent can trigger for integration validation."
        ),

        // MARK: Credentials
        .init(
            key: "githubPat",
            label: "GitHub PAT",
            section: .credentials,
            help: "Personal access token for GitHub PR and action operations."
        ),
        .init(
            key: "adoPat",
            label: "ADO PAT",
            section: .credentials,
            help: "Personal access token for Azure DevOps."
        ),
        .init(
            key: "registryPat",
            label: "Registry PAT",
            section: .credentials,
            help: "PAT used by private npm/NuGet registries."
        ),

        // MARK: Injections
        .init(
            key: "mcpServers",
            label: "MCP Servers",
            section: .injections,
            help: "Extra MCP servers merged into the agent container."
        ),
        .init(
            key: "claudeMdSections",
            label: "CLAUDE.md Sections",
            section: .injections,
            help: "Extra sections appended to the container CLAUDE.md."
        ),
        .init(
            key: "skills",
            label: "Skills",
            section: .injections,
            help: "Slash-command skills injected into agent sessions."
        ),
        .init(
            key: "privateRegistries",
            label: "Private Registries",
            section: .injections,
            help: "npm / NuGet feeds added to the container."
        ),
    ]

    /// Field keys that are always visible on derived profiles (never hidden
    /// even if inherited). Currently just `modelProvider` / credentials,
    /// which are rendered as a dedicated Providers card.
    public static let alwaysVisible: Set<String> = []

    /// Lookup helper.
    public static func field(for key: String) -> ProfileOverrideField? {
        all.first { $0.key == key }
    }

    public static var bySection: [(ProfileOverrideFieldSection, [ProfileOverrideField])] {
        ProfileOverrideFieldSection.allCases.map { section in
            (section, all.filter { $0.section == section })
        }.filter { !$0.1.isEmpty }
    }
}
