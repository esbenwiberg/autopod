import AutopodClient
import SwiftUI

// MARK: - Profile section navigation

enum ProfileSection: String, CaseIterable, Identifiable {
    case general
    case buildRun
    case agent
    case providers
    case escalation
    case container
    case network
    case actions
    case issueWatcher
    case validation
    case credentials
    case injections
    case memory

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general:    "General"
        case .buildRun:   "Build & Run"
        case .agent:      "Agent"
        case .providers:  "Providers"
        case .escalation: "Escalation"
        case .container:  "Container"
        case .network:    "Network & Security"
        case .actions:    "Actions"
        case .issueWatcher: "Issue Watcher"
        case .validation: "Validation"
        case .credentials: "Credentials"
        case .injections: "Injections"
        case .memory:     "Memory"
        }
    }

    var icon: String {
        switch self {
        case .general:    "info.circle"
        case .buildRun:   "hammer"
        case .agent:      "cpu"
        case .providers:  "network"
        case .escalation: "bubble.left.and.exclamationmark.bubble.right"
        case .container:  "server.rack"
        case .network:    "shield.checkered"
        case .actions:    "bolt.shield"
        case .issueWatcher: "eye"
        case .validation: "globe"
        case .credentials: "key"
        case .injections: "syringe"
        case .memory:     "brain"
        }
    }

    var description: String {
        switch self {
        case .general:
            "Core identity and repository settings for this profile."
        case .buildRun:
            "Commands executed inside the container to build, test, and run the application."
        case .agent:
            "AI model and runtime configuration for code generation pods."
        case .providers:
            "AI model provider and code platform — where PRs are created, which service the Issue Watcher monitors, and OAuth credentials."
        case .escalation:
            "Controls how and when the agent escalates to humans or other AI models. Also configures token budget limits."
        case .container:
            "Execution environment and resource limits for the agent container."
        case .network:
            "Outbound network access controls for container isolation."
        case .actions:
            "Control plane actions the agent can execute — GitHub, ADO, Azure, and custom HTTP."
        case .issueWatcher:
            "Automatically pick up GitHub Issues or ADO Work Items by label and create pods. Ideal for mobile-triggered workflows."
        case .validation:
            "Smoke test pages loaded after the app starts to verify correctness."
        case .credentials:
            "PATs for Git providers and package registries. OAuth credentials are managed in Providers."
        case .injections:
            "Additional tools, documentation, and commands injected into agent containers."
        case .memory:
            "Persistent memory entries injected into agent pods for this profile. Agents can suggest new memories via memory_suggest."
        }
    }

    var searchKeywords: [String] {
        switch self {
        case .general:
            ["repository", "repo url", "branch", "branch prefix", "template", "output mode", "extends", "worker profile", "autopod/", "git", "clone"]
        case .buildRun:
            ["build command", "start command", "test command", "health path", "timeout", "npm", "dotnet", "python", "compile"]
        case .agent:
            ["model", "opus", "sonnet", "runtime", "claude", "codex", "copilot", "custom instructions", "system prompt"]
        case .providers:
            ["model provider", "anthropic", "max", "foundry", "azure foundry", "copilot", "pr provider", "code platform", "github", "ado", "azure devops", "oauth", "authenticate", "login", "endpoint", "project id", "api key"]
        case .escalation:
            ["escalation", "ask human", "ai consultation", "advisor", "auto pause", "guardrails", "human response timeout", "token budget", "budget", "soft", "hard", "warn at", "extensions", "limit"]
        case .container:
            ["execution target", "docker", "aci", "azure container instances", "memory", "memory limit", "warm image"]
        case .network:
            ["network", "isolation", "firewall", "allow all", "deny all", "restricted", "allowed hosts", "package managers", "egress"]
        case .actions:
            ["actions", "github issues", "github prs", "github code", "ado workitems", "ado prs", "azure logs", "azure pim", "pim", "action overrides", "sanitization", "quarantine", "custom actions"]
        case .issueWatcher:
            ["issue watcher", "label", "github issues", "ado work items", "watcher", "trigger", "mobile", "label prefix"]
        case .validation:
            ["validation", "smoke test", "smoke pages", "max attempts", "has web ui", "web ui", "browser", "playwright"]
        case .credentials:
            ["pat", "personal access token", "github pat", "ado pat", "registry pat", "private registry", "npm", "nuget", "encrypted"]
        case .injections:
            ["mcp", "mcp servers", "claude.md", "sections", "skills", "slash commands", "injection", "tools"]
        case .memory:
            ["memory", "persistent", "memory_suggest", "memory entries"]
        }
    }
}

// MARK: - Help badge (click to show popover)

struct HelpBadge: View {
    let text: String
    @State private var isShowing = false

    var body: some View {
        Button {
            isShowing.toggle()
        } label: {
            Image(systemName: "questionmark.circle")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $isShowing, arrowEdge: .trailing) {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(width: 240, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Profile editor

/// Callback for profile authentication flows.
/// Parameters: profile name, provider ("max" or "copilot"), completion callback (error message or nil).
public typealias ProfileAuthHandler = (String, String, @escaping (String?) -> Void) -> Void

/// Profile editor — settings-style layout with sidebar section navigation and inline help.
public struct ProfileEditorView: View {
    @State public var profile: Profile
    public let isNew: Bool
    public let actionCatalog: [ActionCatalogItem]
    public var onSave: ((Profile) -> Void)?
    public var onAuthenticate: ProfileAuthHandler?
    public var memoryEntries: [MemoryEntry] = []
    public var onApproveMemory: (String) -> Void = { _ in }
    public var onRejectMemory: (String) -> Void = { _ in }
    public var onDeleteMemory: (String) -> Void = { _ in }
    public var onEditMemory: ((String, String) -> Void)?

    public init(profile: Profile, isNew: Bool,
                actionCatalog: [ActionCatalogItem] = [],
                onSave: ((Profile) -> Void)? = nil,
                onAuthenticate: ProfileAuthHandler? = nil,
                memoryEntries: [MemoryEntry] = [],
                onApproveMemory: @escaping (String) -> Void = { _ in },
                onRejectMemory: @escaping (String) -> Void = { _ in },
                onDeleteMemory: @escaping (String) -> Void = { _ in },
                onEditMemory: ((String, String) -> Void)? = nil) {
        self._profile = State(initialValue: profile)
        self.isNew = isNew
        self.actionCatalog = actionCatalog
        self.onSave = onSave
        self.onAuthenticate = onAuthenticate
        self.memoryEntries = memoryEntries
        self.onApproveMemory = onApproveMemory
        self.onRejectMemory = onRejectMemory
        self.onDeleteMemory = onDeleteMemory
        self.onEditMemory = onEditMemory
    }

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSection: ProfileSection = .general
    @State private var authStatus: AuthStatus?
    @State private var searchText: String = ""
    @State private var searchLastSection: ProfileSection = .general

    private var filteredSections: [ProfileSection] {
        guard !searchText.isEmpty else { return ProfileSection.allCases }
        let q = searchText.lowercased()
        return ProfileSection.allCases.filter {
            $0.label.lowercased().contains(q) ||
            $0.description.lowercased().contains(q) ||
            $0.searchKeywords.contains { $0.contains(q) }
        }
    }

    private enum AuthStatus: Equatable {
        case inProgress(String)
        case success(String)
        case failure(String)
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack(spacing: 0) {
                sectionSidebar
                Divider()
                sectionContent
            }
            Divider()
            actionBar
        }
        .frame(width: 880, height: 720)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text(isNew ? "New Profile" : "Edit Profile")
                .font(.headline)
            if !isNew {
                Text(profile.name)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text("v\(profile.version)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.tertiary)
                    .font(.title3)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 24)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    // MARK: - Section sidebar

    private var sectionSidebar: some View {
        VStack(spacing: 0) {
            // Search field
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                TextField("Search settings", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(.callout))
                    .onChange(of: searchText) { _, newValue in
                        if newValue.isEmpty {
                            // Restore last manually selected section
                            withAnimation(.easeOut(duration: 0.15)) {
                                selectedSection = searchLastSection
                            }
                        } else {
                            // Auto-select first matching section
                            if let first = filteredSections.first, !filteredSections.contains(selectedSection) {
                                withAnimation(.easeOut(duration: 0.15)) {
                                    selectedSection = first
                                }
                            }
                        }
                    }
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(nsColor: .controlBackgroundColor))

            Divider()

            ScrollView {
                VStack(spacing: 1) {
                    if filteredSections.isEmpty {
                        Text("No results")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 16)
                    } else {
                        ForEach(filteredSections) { section in
                            Button {
                                withAnimation(.easeOut(duration: 0.15)) {
                                    selectedSection = section
                                    if searchText.isEmpty {
                                        searchLastSection = section
                                    }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: section.icon)
                                        .font(.system(size: 12))
                                        .frame(width: 18)
                                        .foregroundStyle(selectedSection == section ? .white : .blue)
                                    Text(section.label)
                                        .font(.system(.callout))
                                        .foregroundStyle(selectedSection == section ? .white : .primary)
                                    Spacer()
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(selectedSection == section ? Color.accentColor : .clear)
                                )
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(8)
            }
        }
        .frame(width: 190)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    // MARK: - Section content

    private var sectionContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeader(selectedSection)

                switch selectedSection {
                case .general:      generalFields
                case .buildRun:     buildRunFields
                case .agent:        agentFields
                case .providers:    providersFields
                case .escalation:   escalationFields
                case .container:    containerFields
                case .network:      networkFields
                case .actions:      actionFields
                case .issueWatcher: issueWatcherFields
                case .validation:   validationFields
                case .credentials:  credentialFields
                case .injections:   injectionFields
                case .memory:       memorySection
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Section header

    private func sectionHeader(_ section: ProfileSection) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: section.icon)
                    .font(.system(size: 14))
                    .foregroundStyle(.blue)
                Text(section.label)
                    .font(.title3.weight(.semibold))
            }
            Text(section.description)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 4)
    }

    // MARK: - Action bar

    private var actionBar: some View {
        HStack {
            if !isNew {
                Button("Delete", role: .destructive) {}
                    .foregroundStyle(.red)
            }
            Spacer()
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(isNew ? "Create" : "Save") {
                onSave?(profile)
                dismiss()
            }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(isNew && profile.name.isEmpty)
        }
        .padding(16)
    }

    // MARK: - General

    @ViewBuilder
    private var generalFields: some View {
        if isNew {
            fieldRow("Name", help: "Unique identifier used in CLI commands and API calls.") {
                TextField("my-app", text: $profile.name)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
            }
        }
        fieldRow("Repository URL", help: "Git clone URL. HTTPS recommended — SSH needs key setup in the container.") {
            TextField("https://github.com/org/repo.git", text: $profile.repoUrl)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
        }
        HStack(spacing: 16) {
            fieldRow("Default Branch", help: "Base branch for worktrees. Feature branches are created off this.") {
                TextField("main", text: $profile.defaultBranch)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)
            }
            fieldRow("Branch Prefix", help: "Prefix for auto-generated pod branch names. e.g. 'autopod/' → 'autopod/abc12345'. Set per-pod to override.") {
                TextField("autopod/", text: $profile.branchPrefix)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                    .frame(width: 160)
            }
        }
        HStack(spacing: 24) {
            fieldRow("Template", help: "Container image and toolchain — determines pre-installed runtimes and build tools.") {
                Picker("", selection: $profile.template) {
                    ForEach(StackTemplate.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .frame(width: 220)
            }
            fieldRow("Agent Mode", help: "Agent runs to completion (auto) or human drives an interactive container.") {
                Picker("", selection: $profile.pod.agentMode) {
                    ForEach(AgentMode.allCases, id: \.self) { m in
                        Text(m.label).tag(m)
                    }
                }
                .labelsHidden()
                .frame(width: 180)
                .onChange(of: profile.pod.agentMode) { _, newValue in
                    if newValue == .interactive {
                        if profile.pod.output == .pr { profile.pod.output = .branch }
                        profile.pod.promotable = true
                        profile.pod.validate = false
                    } else {
                        profile.pod.promotable = false
                        if profile.pod.output == .branch || profile.pod.output == .none {
                            profile.pod.output = .pr
                        }
                        profile.pod.validate = true
                    }
                }
            }
        }
        HStack(spacing: 24) {
            fieldRow("Output", help: "Where pod output goes — PR opens a pull request, Branch pushes only, Artifact extracts /workspace, Ephemeral discards everything.") {
                Picker("", selection: $profile.pod.output) {
                    ForEach(OutputTarget.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .frame(width: 180)
            }
            fieldRow("Validate", help: "Run the full build / smoke / review pipeline before completing.") {
                Toggle("Run validation", isOn: $profile.pod.validate)
                    .toggleStyle(.switch)
                    .labelsHidden()
            }
            fieldRow("Promotable", help: "Allow promoting this pod to agent-driven mid-flight (interactive → auto).") {
                Toggle("Allow promotion", isOn: $profile.pod.promotable)
                    .toggleStyle(.switch)
                    .labelsHidden()
            }
        }

        fieldRow("Extends", help: "Inherit settings from another profile. Fields set here override the parent.") {
            TextField("Parent profile name (optional)", text: Binding(
                get: { profile.extendsProfile ?? "" },
                set: { profile.extendsProfile = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .frame(width: 280)
        }

        fieldRow("Worker Profile", help: "Profile to use when launching worker pods from a workspace pod using this profile.") {
            TextField("Worker profile name (optional)", text: Binding(
                get: { profile.workerProfile ?? "" },
                set: { profile.workerProfile = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .frame(width: 280)
        }
    }

    // MARK: - Build & Run

    @ViewBuilder
    private var buildRunFields: some View {
        fieldRow("Build Command", help: "Compiles the project. Runs after repo clone inside the container.") {
            TextField("npm run build", text: $profile.buildCommand)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
        }
        fieldRow("Start Command", help: "Starts the app server for health checks and smoke testing.") {
            TextField("npm start", text: $profile.startCommand)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
        }
        fieldRow("Test Command", help: "Runs after build to verify tests pass. Leave empty to skip.") {
            TextField("Optional", text: Binding(
                get: { profile.testCommand ?? "" },
                set: { profile.testCommand = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }
        fieldRow("Health Path", help: "HTTP endpoint polled to determine when the app is ready (expects 200 OK).") {
            TextField("/", text: $profile.healthPath)
                .textFieldStyle(.roundedBorder)
                .frame(width: 180)
        }

        Divider().padding(.vertical, 4)

        Text("Timeouts")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        HStack(spacing: 24) {
            fieldRow("Health", help: "Seconds to wait for the health endpoint before giving up.") {
                Stepper("\(profile.healthTimeout)s", value: $profile.healthTimeout, in: 10...600, step: 10)
                    .frame(width: 110)
            }
            fieldRow("Build", help: "Max seconds for the build command before it's killed.") {
                Stepper("\(profile.buildTimeout)s", value: $profile.buildTimeout, in: 60...1800, step: 30)
                    .frame(width: 110)
            }
            fieldRow("Test", help: "Max seconds for the test command before it's killed.") {
                Stepper("\(profile.testTimeout)s", value: $profile.testTimeout, in: 60...3600, step: 60)
                    .frame(width: 110)
            }
        }
    }

    // MARK: - Agent

    @ViewBuilder
    private var agentFields: some View {
        HStack(spacing: 24) {
            fieldRow("Default Model", help: "Opus is more capable but slower; Sonnet is faster and cheaper.") {
                Picker("", selection: $profile.defaultModel) {
                    Text("Opus").tag("opus")
                    Text("Sonnet").tag("sonnet")
                }
                .labelsHidden()
                .frame(width: 130)
            }
            fieldRow("Runtime", help: "AI runtime engine — Claude Code, OpenAI Codex, or GitHub Copilot.") {
                Picker("", selection: $profile.defaultRuntime) {
                    ForEach(RuntimeType.allCases, id: \.self) { r in
                        Text(r.rawValue.capitalized).tag(r)
                    }
                }
                .labelsHidden()
                .frame(width: 130)
            }
        }
        fieldRow("Custom Instructions", help: "Appended to the agent's system prompt. Use for project conventions, constraints, or domain context.") {
            TextEditor(text: Binding(
                get: { profile.customInstructions ?? "" },
                set: { profile.customInstructions = $0.isEmpty ? nil : $0 }
            ))
            .font(.system(.caption, design: .monospaced))
            .frame(height: 120)
            .padding(4)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
            )
        }
    }

    // MARK: - Escalation

    @ViewBuilder
    private var escalationFields: some View {
        Toggle(isOn: $profile.escalationAskHuman) {
            HStack(spacing: 4) {
                Text("Allow human escalation")
                HelpBadge(text: "When enabled, the agent can pause and ask a human reviewer for guidance.")
            }
        }

        Divider().padding(.vertical, 4)

        Text("AI Consultation")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        Toggle(isOn: $profile.escalationAskAiEnabled) {
            HStack(spacing: 4) {
                Text("Allow AI-to-AI consultation")
                HelpBadge(text: "The agent can consult another AI model for second opinions or specialized knowledge.")
            }
        }

        if profile.escalationAskAiEnabled {
            HStack(spacing: 24) {
                fieldRow("Consultation Model", help: "Which model to consult. Sonnet is cheaper; Opus is more thorough.") {
                    Picker("", selection: $profile.escalationAskAiModel) {
                        Text("Sonnet").tag("sonnet")
                        Text("Opus").tag("opus")
                    }
                    .labelsHidden()
                    .frame(width: 130)
                }
                fieldRow("Max Calls", help: "Maximum number of AI consultations per pod before forcing human escalation.") {
                    Stepper("\(profile.escalationAskAiMaxCalls)", value: $profile.escalationAskAiMaxCalls, in: 1...20)
                        .frame(width: 110)
                }
            }
        }

        Divider().padding(.vertical, 4)

        Text("AI Advisor")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        Toggle(isOn: $profile.escalationAdvisorEnabled) {
            HStack(spacing: 4) {
                Text("Enable Advisor Mode")
                HelpBadge(text: "When enabled, the agent is instructed to proactively consult the AI reviewer at critical decision points — before complex logic, when stuck, and before completing the task.")
            }
        }

        Divider().padding(.vertical, 4)

        Text("Guardrails")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        HStack(spacing: 24) {
            fieldRow("Auto-pause After", help: "Number of escalation attempts before the pod is automatically paused. Prevents runaway loops.") {
                Stepper("\(profile.escalationAutoPauseAfter)", value: $profile.escalationAutoPauseAfter, in: 1...20)
                    .frame(width: 110)
            }
            fieldRow("Human Response Timeout", help: "Seconds to wait for a human response before timing out the escalation.") {
                HStack(spacing: 4) {
                    TextField("3600", value: $profile.escalationHumanResponseTimeout, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 80)
                    Text("sec")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }

        // Human-friendly summary
        HStack(spacing: 4) {
            Image(systemName: "info.circle")
                .foregroundStyle(.blue.opacity(0.6))
            let hours = profile.escalationHumanResponseTimeout / 3600
            let mins = (profile.escalationHumanResponseTimeout % 3600) / 60
            Text(hours > 0
                 ? "Human has \(hours)h \(mins)m to respond before timeout."
                 : "Human has \(mins)m to respond before timeout.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.top, 2)

        Divider().padding(.vertical, 4)

        Text("Token Budget")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        Toggle(isOn: Binding(
            get: { profile.tokenBudget != nil },
            set: { enabled in
                if enabled { profile.tokenBudget = 500_000 }
                else { profile.tokenBudget = nil }
            }
        )) {
            HStack(spacing: 4) {
                Text("Enable token budget")
                HelpBadge(text: "Limit the total tokens (input + output) consumed per pod. Useful for cost control.")
            }
        }

        if profile.tokenBudget != nil {
            HStack(spacing: 24) {
                fieldRow("Budget (tokens)", help: "Maximum total tokens allowed per pod. null = unlimited.") {
                    TextField("500000", value: Binding(
                        get: { profile.tokenBudget ?? 500_000 },
                        set: { profile.tokenBudget = $0 }
                    ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 110)
                }
                fieldRow("Policy", help: "Soft: pause and ask for approval when exceeded. Hard: fail immediately.") {
                    Picker("", selection: $profile.tokenBudgetPolicy) {
                        ForEach(TokenBudgetPolicy.allCases, id: \.self) { p in
                            Text(p.label).tag(p)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 110)
                }
            }
            HStack(spacing: 24) {
                fieldRow("Warn At", help: "Fraction of the budget at which a warning is emitted (0–100%).") {
                    HStack(spacing: 6) {
                        Slider(value: $profile.tokenBudgetWarnAt, in: 0...1, step: 0.05)
                            .frame(width: 100)
                        Text("\(Int(profile.tokenBudgetWarnAt * 100))%")
                            .monospacedDigit()
                            .frame(width: 36)
                    }
                }
                fieldRow("Max Extensions", help: "How many times a human can approve budget extensions per pod. Leave empty for unlimited.") {
                    HStack(spacing: 6) {
                        TextField("∞", value: Binding(
                            get: { profile.maxBudgetExtensions ?? 0 },
                            set: { profile.maxBudgetExtensions = $0 > 0 ? $0 : nil }
                        ), format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                        if profile.maxBudgetExtensions == nil {
                            Text("unlimited")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Providers (AI model provider + code platform)

    @ViewBuilder
    private var providersFields: some View {
        Text("AI Provider")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        fieldRow("Model Provider", help: "Authentication backend for AI model API calls.") {
            Picker("", selection: $profile.modelProvider) {
                ForEach(ModelProvider.allCases, id: \.self) { p in
                    Text(p.rawValue.capitalized).tag(p)
                }
            }
            .labelsHidden()
            .frame(width: 160)
        }

        // Provider credentials indicator
        if let credType = profile.providerCredentialsType {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text("Credentials configured: \(credType)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        // Foundry-specific fields
        if profile.modelProvider == .foundry {
            HStack(spacing: 16) {
                fieldRow("Endpoint URL", help: "Azure Foundry deployment endpoint URL.") {
                    TextField("https://...", text: Binding(
                        get: { profile.customInstructions ?? "" }, // placeholder — Foundry fields need dedicated storage
                        set: { _ in }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                    .frame(minWidth: 200)
                    .disabled(true)
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .foregroundStyle(.blue.opacity(0.7))
                Text("Foundry endpoint and project ID are configured via the daemon environment variables.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }

        // OAuth auth buttons for MAX and Copilot
        if !isNew && (profile.modelProvider == .max || profile.modelProvider == .copilot) {
            HStack(spacing: 12) {
                if profile.modelProvider == .max {
                    Button {
                        startAuth(provider: "max", label: "Claude MAX")
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "person.badge.key")
                            Text("Authenticate with Claude MAX")
                        }
                    }
                    .disabled(onAuthenticate == nil || authStatus == .inProgress("max"))
                    .help("Opens Claude CLI to complete OAuth login. Credentials are saved to this profile.")
                }
                if profile.modelProvider == .copilot {
                    Button {
                        startAuth(provider: "copilot", label: "Copilot")
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "person.badge.key")
                            Text("Authenticate with Copilot")
                        }
                    }
                    .disabled(onAuthenticate == nil || authStatus == .inProgress("copilot"))
                    .help("Opens GitHub Copilot login. Token is saved to this profile.")
                }
            }

            if let authStatus {
                HStack(spacing: 6) {
                    switch authStatus {
                    case .inProgress(let label):
                        ProgressView().scaleEffect(0.6)
                        Text("Authenticating with \(label)...")
                            .foregroundStyle(.secondary)
                    case .success(let msg):
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text(msg)
                            .foregroundStyle(.green)
                    case .failure(let msg):
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.red)
                        Text(msg)
                            .foregroundStyle(.red)
                    }
                }
                .font(.caption)
            } else {
                Text("Opens an interactive login flow in Terminal. Complete the OAuth flow, then return here.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }

        Divider().padding(.vertical, 4)

        Text("Code Platform")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        fieldRow("Platform", help: "Determines where pull requests are created, which service the Issue Watcher monitors, and which GitHub/ADO read actions are available. Use the Actions section to control fine-grained read access.") {
            Picker("", selection: $profile.prProvider) {
                ForEach(PRProvider.allCases, id: \.self) { p in
                    Text(p.label).tag(p)
                }
            }
            .labelsHidden()
            .frame(width: 180)
        }

        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .foregroundStyle(.blue.opacity(0.6))
            Text(profile.prProvider == .github
                 ? "GitHub — PRs created via GitHub API. Issue Watcher monitors GitHub Issues. Authenticate with a GitHub PAT in Credentials."
                 : "Azure DevOps — PRs created via ADO API. Issue Watcher monitors ADO Work Items. Authenticate with an ADO PAT in Credentials.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Container (was Infrastructure)

    @ViewBuilder
    private var containerFields: some View {
        HStack(spacing: 24) {
            fieldRow("Run Environment", help: "Where containers are created. Local uses Docker on the host machine; ACI runs in Azure cloud.") {
                Picker("", selection: $profile.executionTarget) {
                    ForEach(ExecutionTarget.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .frame(width: 240)
            }
            fieldRow("Memory Limit", help: "Container RAM cap in GB. Leave empty to use host or cloud defaults.") {
                HStack(spacing: 4) {
                    TextField("—", value: Binding(
                        get: { profile.containerMemoryGb ?? 0 },
                        set: { profile.containerMemoryGb = $0 > 0 ? $0 : nil }
                    ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 60)
                    Text("GB")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }

        // Warm image
        if profile.warmImageTag != nil || profile.warmImageBuiltAt != nil {
            Divider().padding(.vertical, 4)

            Text("Warm Image")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            HStack(spacing: 20) {
                if let tag = profile.warmImageTag {
                    HStack(spacing: 4) {
                        Text("Tag:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(tag)
                            .font(.system(.caption, design: .monospaced))
                    }
                }
                if let builtAt = profile.warmImageBuiltAt {
                    HStack(spacing: 4) {
                        Text("Built:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(builtAt)
                            .font(.caption)
                    }
                }
            }

            Text("Warm images are pre-built by the daemon to speed up container startup. Managed automatically.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Network & Security

    @ViewBuilder
    private var networkFields: some View {
        Toggle(isOn: $profile.networkEnabled) {
            HStack(spacing: 4) {
                Text("Enable network isolation")
                HelpBadge(text: "When enabled, controls what the container can reach over the network.")
            }
        }

        if profile.networkEnabled {
            fieldRow("Mode", help: "Allow All = unrestricted outbound. Deny All = air-gapped. Restricted = allowlist only.") {
                Picker("", selection: $profile.networkMode) {
                    ForEach(NetworkPolicyMode.allCases, id: \.self) { m in
                        Text(m.label).tag(m)
                    }
                }
                .labelsHidden()
                .frame(width: 180)
            }

            if profile.networkMode == .restricted {
                Divider().padding(.vertical, 4)

                Toggle(isOn: $profile.allowPackageManagers) {
                    HStack(spacing: 4) {
                        Text("Allow Package Managers")
                        HelpBadge(text: "Auto-allow common package registry hosts: npm, pip, cargo, apt, NuGet, Go modules, and RubyGems.")
                    }
                }

                fieldRow("Allowed Hosts", help: "Hostnames the container can reach in restricted mode. One per row.") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(profile.allowedHosts.indices, id: \.self) { i in
                            HStack(spacing: 6) {
                                TextField("hostname", text: $profile.allowedHosts[i])
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.caption, design: .monospaced))
                                Button {
                                    profile.allowedHosts.remove(at: i)
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(.red.opacity(0.6))
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        Button {
                            profile.allowedHosts.append("")
                        } label: {
                            Label("Add host", systemImage: "plus")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
    }

    // MARK: - Issue Watcher

    @ViewBuilder
    private var issueWatcherFields: some View {
        Toggle(isOn: $profile.issueWatcherEnabled) {
            HStack(spacing: 4) {
                Text("Enable issue watcher")
                HelpBadge(text: "When enabled, polls for GitHub Issues or ADO Work Items with a matching label prefix and automatically creates pods. Label an issue from your phone to trigger a pod.")
            }
        }

        if profile.issueWatcherEnabled {
            Divider().padding(.vertical, 4)

            fieldRow("Label Prefix", help: "The label prefix to watch for. Issues labeled with this prefix (or '<prefix>:<profile>') will trigger pods. Must be lowercase alphanumeric with hyphens.") {
                TextField("autopod", text: $profile.issueWatcherLabelPrefix)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 200)
            }

            Text("Label Routing")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 4) {
                routingRow("autopod", "Uses this profile")
                routingRow("autopod:<profile>", "Routes to named profile")
                routingRow("autopod:artifact", "Uses this profile with artifact output")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.leading, 4)

            Text("Lifecycle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.top, 8)

            VStack(alignment: .leading, spacing: 4) {
                lifecycleRow("autopod", "Trigger — picked up by watcher")
                lifecycleRow("autopod:in-progress", "Pod running")
                lifecycleRow("autopod:done", "Pod completed successfully")
                lifecycleRow("autopod:failed", "Pod failed")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.leading, 4)
        }
    }

    private func routingRow(_ label: String, _ desc: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.blue.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(desc)
        }
    }

    private func lifecycleRow(_ label: String, _ desc: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(desc)
        }
    }

    // MARK: - Actions

    @ViewBuilder
    private var actionFields: some View {
        ActionsSection(profile: $profile, actionCatalog: actionCatalog)
    }

    // MARK: - Validation

    @ViewBuilder
    private var validationFields: some View {
        Toggle(isOn: $profile.hasWebUi) {
            HStack(spacing: 4) {
                Text("Has Web UI")
                HelpBadge(text: "When disabled, browser-based smoke tests are skipped entirely. Use this for API-only or CLI services with no HTTP frontend.")
            }
        }

        Divider().padding(.vertical, 4)

        fieldRow("Max Attempts", help: "How many times the agent can retry after a failed smoke test before the pod is marked failed.") {
            Stepper("\(profile.maxValidationAttempts)", value: $profile.maxValidationAttempts, in: 1...10)
                .frame(width: 120)
        }

        if profile.hasWebUi {
            Divider().padding(.vertical, 4)

            fieldRow("Smoke Pages", help: "Each page is loaded in a headless browser after the app starts. Verifies the app renders correctly.") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(profile.smokePages.indices, id: \.self) { i in
                    HStack(spacing: 6) {
                        TextField("/path", text: $profile.smokePages[i].path)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        Button {
                            profile.smokePages.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button {
                    profile.smokePages.append(SmokePage(path: "/"))
                } label: {
                    Label("Add page", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }

        if profile.smokePages.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .foregroundStyle(.orange)
                Text("No smoke pages configured. Validation will be skipped.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        }
        } // end if profile.hasWebUi
    }

    // MARK: - Credentials

    @ViewBuilder
    private var credentialFields: some View {
        // Info banner pointing to Providers for OAuth
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(.blue.opacity(0.7))
            Text("OAuth credentials for Claude MAX and GitHub Copilot are managed in the **Providers** section.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(.blue.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.blue.opacity(0.15), lineWidth: 0.5))

        patRow("GitHub PAT", value: $profile.githubPat, isSet: profile.hasGithubPat,
               help: "Personal access token for GitHub — needed for PR creation and private repo cloning.")
        patRow("ADO PAT", value: $profile.adoPat, isSet: profile.hasAdoPat,
               help: "Azure DevOps token — needed for ADO repos, PRs, and package feeds.")
        patRow("Registry PAT", value: $profile.registryPat, isSet: profile.hasRegistryPat,
               help: "Token for private npm or NuGet registries configured below.")

        Divider().padding(.vertical, 4)

        fieldRow("Private Registries", help: "Package registry URLs injected as .npmrc or NuGet.config in the container.") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(profile.privateRegistries.indices, id: \.self) { i in
                    HStack(spacing: 8) {
                        Picker("", selection: $profile.privateRegistries[i].type) {
                            ForEach(RegistryType.allCases, id: \.self) { t in
                                Text(t.rawValue.uppercased()).tag(t)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 80)

                        TextField("https://registry.example.com/...", text: $profile.privateRegistries[i].url)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))

                        TextField("scope", text: Binding(
                            get: { profile.privateRegistries[i].scope ?? "" },
                            set: { profile.privateRegistries[i].scope = $0.isEmpty ? nil : $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 100)

                        Button {
                            profile.privateRegistries.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button {
                    profile.privateRegistries.append(PrivateRegistry(type: .npm, url: ""))
                } label: {
                    Label("Add registry", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }

        Text("Credentials are encrypted at rest. Existing values cannot be displayed.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .padding(.top, 4)
    }

    // MARK: - Memory

    private var memorySection: some View {
        MemoryManagementView(
            entries: memoryEntries.filter { $0.scope == .profile },
            scopeFilter: .profile,
            onApprove: onApproveMemory,
            onReject: onRejectMemory,
            onDelete: onDeleteMemory,
            onEdit: onEditMemory
        )
    }

    // MARK: - Injections

    @ViewBuilder
    private var injectionFields: some View {
        // MCP Servers
        fieldRow("MCP Servers", help: "Model Context Protocol servers providing extra tools to the agent inside the container.") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(profile.mcpServers.indices, id: \.self) { i in
                    HStack(spacing: 8) {
                        TextField("name", text: $profile.mcpServers[i].name)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .frame(width: 120)
                        TextField("http://localhost:9222", text: $profile.mcpServers[i].url)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        TextField("description", text: Binding(
                            get: { profile.mcpServers[i].description ?? "" },
                            set: { profile.mcpServers[i].description = $0.isEmpty ? nil : $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 140)
                        Button {
                            profile.mcpServers.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button {
                    profile.mcpServers.append(InjectedMcpServer())
                } label: {
                    Label("Add MCP server", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }

        Divider().padding(.vertical, 4)

        // CLAUDE.md Sections
        fieldRow("CLAUDE.md Sections", help: "Markdown content appended to the agent's CLAUDE.md instructions file.") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(profile.claudeMdSections.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            TextField("Heading", text: $profile.claudeMdSections[i].heading)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                            Button {
                                profile.claudeMdSections.remove(at: i)
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .foregroundStyle(.red.opacity(0.6))
                            }
                            .buttonStyle(.borderless)
                        }
                        TextEditor(text: $profile.claudeMdSections[i].content)
                            .font(.system(.caption, design: .monospaced))
                            .frame(height: 60)
                            .padding(4)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                            )
                    }
                }
                Button {
                    profile.claudeMdSections.append(InjectedClaudeMdSection())
                } label: {
                    Label("Add section", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }

        Divider().padding(.vertical, 4)

        // Skills
        fieldRow("Skills", help: "Slash commands available to the agent in the container.") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(profile.skills.indices, id: \.self) { i in
                    HStack(spacing: 8) {
                        TextField("name", text: $profile.skills[i].name)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .frame(width: 140)
                        TextField("description", text: Binding(
                            get: { profile.skills[i].description ?? "" },
                            set: { profile.skills[i].description = $0.isEmpty ? nil : $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        Button {
                            profile.skills.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button {
                    profile.skills.append(InjectedSkill())
                } label: {
                    Label("Add skill", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    // MARK: - Field row helper

    private func fieldRow<Content: View>(
        _ label: String,
        help: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let help {
                    HelpBadge(text: help)
                }
            }
            content()
        }
    }

    // MARK: - Auth flow trigger

    private func startAuth(provider: String, label: String) {
        authStatus = .inProgress(label)
        onAuthenticate?(profile.name, provider) { errorMessage in
            if let errorMessage {
                authStatus = .failure(errorMessage)
            } else {
                authStatus = .success("Authenticated with \(label)")
            }
        }
    }

    // MARK: - PAT row (secure input with status)

    private func patRow(_ label: String, value: Binding<String?>, isSet: Bool, help: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HelpBadge(text: help)
                Spacer()
                if isSet && (value.wrappedValue ?? "").isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("Configured")
                            .foregroundStyle(.secondary)
                    }
                    .font(.caption)
                }
            }
            SecureField(isSet ? "Enter new value to replace" : "Enter token", text: Binding(
                get: { value.wrappedValue ?? "" },
                set: { value.wrappedValue = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.caption, design: .monospaced))
        }
    }
}

// MARK: - Actions section

private struct ActionsSection: View {
    @Binding var profile: Profile
    let actionCatalog: [ActionCatalogItem]

    var body: some View {
        Toggle(isOn: $profile.actionPolicyEnabled) {
            HStack(spacing: 4) {
                Text("Enable action policy")
                HelpBadge(text: "When enabled, agents can execute control-plane actions like reading GitHub issues, ADO work items, or calling custom HTTP endpoints.")
            }
        }

        if profile.actionPolicyEnabled {
            Divider().padding(.vertical, 4)

            Text("Enabled Actions")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            actionGroupDisclosures

            Divider().padding(.vertical, 4)

            HStack {
                Text("Action Overrides")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                HelpBadge(text: "Per-action restrictions. Limit an action to specific repos (exact or wildcard, e.g. myorg/*) and optionally require a human to approve before it runs.")
                Spacer()
                Button {
                    profile.actionOverrides.append(ActionOverride())
                } label: {
                    Label("Add Override", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }

            if profile.actionOverrides.isEmpty {
                Text("No overrides — all enabled actions run without restrictions.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach($profile.actionOverrides) { $override in
                        HStack(alignment: .center, spacing: 8) {
                            actionNamePicker(selection: $override.action)

                            TextField("repos (myorg/*, myorg/repo)", text: Binding(
                                get: { override.allowedResources.joined(separator: ", ") },
                                set: { raw in
                                    override.allowedResources = raw
                                        .split(separator: ",")
                                        .map { $0.trimmingCharacters(in: .whitespaces) }
                                        .filter { !$0.isEmpty }
                                }
                            ))
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minWidth: 180)
                            .help("Comma-separated repo patterns. Supports wildcards: myorg/* allows all repos in the org.")

                            Toggle("Approval", isOn: $override.requiresApproval)
                                .toggleStyle(.checkbox)
                                .help("Require a human to approve this action before it runs")
                                .frame(width: 80)

                            Toggle("Disabled", isOn: $override.disabled)
                                .toggleStyle(.checkbox)
                                .help("Completely disable this action for pods using this profile")
                                .frame(width: 70)

                            Button {
                                profile.actionOverrides.removeAll { $0.id == override.id }
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .foregroundStyle(.red.opacity(0.6))
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
                .padding(.leading, 4)
            }

            Divider().padding(.vertical, 4)

            HStack {
                Text("PIM Activations")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                HelpBadge(text: "Security allowlist for Azure PIM actions. Agents can only activate RBAC roles and Entra groups listed here.")
                Spacer()
                Button {
                    profile.pimActivations.append(PimActivationEntry())
                } label: {
                    Label("Add", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }

            if profile.pimActivations.isEmpty {
                Text("No PIM activations configured. Add entries to allow agents to activate Azure RBAC roles or Entra group memberships via the ACP.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach($profile.pimActivations) { $entry in
                        PimActivationRow(entry: $entry, onDelete: {
                            profile.pimActivations.removeAll { $0.id == entry.id }
                        })
                    }
                }
                .padding(.leading, 4)
            }

            Divider().padding(.vertical, 4)

            Text("Data Sanitization")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            fieldRow("Preset", help: "Controls how aggressively PII and sensitive data are stripped from action responses before the agent sees them.") {
                Picker("", selection: $profile.actionSanitizationPreset) {
                    ForEach(SanitizationPreset.allCases, id: \.self) { p in
                        Text(p.label).tag(p)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
            }

            Text(profile.actionSanitizationPreset.description)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, -8)

            fieldRow("Allowed Domains", help: "Domains excluded from sanitization filtering. Data from these domains passes through unmodified.") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(profile.actionSanitizationAllowedDomains.indices, id: \.self) { i in
                        HStack(spacing: 6) {
                            TextField("example.com", text: $profile.actionSanitizationAllowedDomains[i])
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                            Button {
                                profile.actionSanitizationAllowedDomains.remove(at: i)
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .foregroundStyle(.red.opacity(0.6))
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                    Button {
                        profile.actionSanitizationAllowedDomains.append("")
                    } label: {
                        Label("Add domain", systemImage: "plus")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }

            Divider().padding(.vertical, 4)

            Text("Quarantine")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            Toggle(isOn: $profile.actionQuarantineEnabled) {
                HStack(spacing: 4) {
                    Text("Enable quarantine")
                    HelpBadge(text: "Quarantine scores action responses for PII risk. High-scoring responses are blocked or escalated.")
                }
            }

            if profile.actionQuarantineEnabled {
                HStack(spacing: 24) {
                    fieldRow("Warn Threshold", help: "PII score (0–1) at which a warning is logged.") {
                        HStack(spacing: 6) {
                            Slider(value: $profile.actionQuarantineThreshold, in: 0...1, step: 0.05)
                                .frame(width: 100)
                            Text(String(format: "%.2f", profile.actionQuarantineThreshold))
                                .monospacedDigit()
                                .frame(width: 36)
                        }
                    }
                    fieldRow("Block Threshold", help: "PII score (0–1) at which the response is blocked entirely.") {
                        HStack(spacing: 6) {
                            Slider(value: $profile.actionQuarantineBlockThreshold, in: 0...1, step: 0.05)
                                .frame(width: 100)
                            Text(String(format: "%.2f", profile.actionQuarantineBlockThreshold))
                                .monospacedDigit()
                                .frame(width: 36)
                        }
                    }
                    fieldRow("On Block", help: "What happens when a response is blocked — skip silently or escalate to human.") {
                        Picker("", selection: $profile.actionQuarantineOnBlock) {
                            ForEach(QuarantineOnBlock.allCases, id: \.self) { o in
                                Text(o.label).tag(o)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 140)
                    }
                }
            }
        }
    }

    // MARK: - Action disclosure groups

    private var catalogByGroup: [String: [ActionCatalogItem]] {
        Dictionary(grouping: actionCatalog, by: \.group)
    }

    @ViewBuilder
    private var actionGroupDisclosures: some View {
        if actionCatalog.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 8)], alignment: .leading, spacing: 8) {
                ForEach(ActionGroup.allCases, id: \.self) { group in
                    Toggle(isOn: Binding(
                        get: { profile.actionEnabledGroups.contains(group) },
                        set: { enabled in
                            if enabled { profile.actionEnabledGroups.insert(group) }
                            else { profile.actionEnabledGroups.remove(group) }
                        }
                    )) {
                        Text(group.label)
                            .font(.callout)
                    }
                    .toggleStyle(.checkbox)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(ActionGroup.allCases, id: \.self) { group in
                    let items = catalogByGroup[group.rawValue] ?? []
                    if !items.isEmpty {
                        actionGroupRow(group: group, items: items)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actionGroupRow(group: ActionGroup, items: [ActionCatalogItem]) -> some View {
        let groupEnabled = profile.actionEnabledGroups.contains(group)
        let enabledCount = items.filter { isActionEnabled($0.name, group: group) }.count

        DisclosureGroup {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items) { item in
                    Toggle(isOn: Binding(
                        get: { isActionEnabled(item.name, group: group) },
                        set: { enabled in toggleAction(item.name, group: group, enabled: enabled) }
                    )) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.name)
                                .font(.system(.caption, design: .monospaced))
                            Text(item.description)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .toggleStyle(.checkbox)
                    .padding(.leading, 8)
                }
            }
        } label: {
            Toggle(isOn: Binding(
                get: { groupEnabled },
                set: { enabled in toggleGroup(group, items: items, enabled: enabled) }
            )) {
                HStack(spacing: 6) {
                    Text(group.label)
                        .font(.callout)
                    if enabledCount > 0 && enabledCount < items.count {
                        Text("\(enabledCount) of \(items.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
            }
            .toggleStyle(.checkbox)
        }
    }

    private func isActionEnabled(_ name: String, group: ActionGroup) -> Bool {
        let hasDisabledOverride = profile.actionOverrides.contains { $0.action == name && $0.disabled }
        if hasDisabledOverride { return false }
        return profile.actionEnabledGroups.contains(group) || profile.actionEnabledActions.contains(name)
    }

    private func toggleAction(_ name: String, group: ActionGroup, enabled: Bool) {
        if enabled {
            if profile.actionEnabledGroups.contains(group) {
                profile.actionOverrides.removeAll { $0.action == name && $0.disabled }
            } else {
                profile.actionEnabledActions.insert(name)
            }
        } else {
            if profile.actionEnabledGroups.contains(group) {
                if !profile.actionOverrides.contains(where: { $0.action == name }) {
                    profile.actionOverrides.append(ActionOverride(action: name, disabled: true))
                } else {
                    if let idx = profile.actionOverrides.firstIndex(where: { $0.action == name }) {
                        profile.actionOverrides[idx].disabled = true
                    }
                }
            } else {
                profile.actionEnabledActions.remove(name)
            }
        }
    }

    private func toggleGroup(_ group: ActionGroup, items: [ActionCatalogItem], enabled: Bool) {
        if enabled {
            profile.actionEnabledGroups.insert(group)
            for item in items {
                profile.actionEnabledActions.remove(item.name)
            }
            profile.actionOverrides.removeAll { o in
                o.disabled && items.contains { $0.name == o.action }
            }
        } else {
            profile.actionEnabledGroups.remove(group)
        }
    }

    @ViewBuilder
    private func actionNamePicker(selection: Binding<String>) -> some View {
        if actionCatalog.isEmpty {
            TextField("action name", text: selection)
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .frame(width: 160)
        } else {
            Picker("", selection: selection) {
                Text("Select action...").tag("")
                ForEach(ActionGroup.allCases, id: \.self) { group in
                    let items = catalogByGroup[group.rawValue] ?? []
                    if !items.isEmpty {
                        Section(group.label) {
                            ForEach(items) { item in
                                Text(item.name).tag(item.name)
                            }
                        }
                    }
                }
            }
            .labelsHidden()
            .frame(width: 160)
        }
    }

    private func fieldRow<Content: View>(
        _ label: String,
        help: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let help {
                    HelpBadge(text: help)
                }
            }
            content()
        }
    }
}

// MARK: - PIM activation row (extracted to reduce ActionsSection node count)

private struct PimActivationRow: View {
    @Binding var entry: PimActivationEntry
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Picker("", selection: $entry.type) {
                    ForEach(PimActivationType.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .frame(width: 120)

                if entry.type == .rbacRole {
                    TextField("ARM scope (/subscriptions/…)", text: $entry.scope)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .help("ARM resource scope, e.g. /subscriptions/{id}/resourceGroups/{rg}")
                } else {
                    TextField("Group ID (UUID)", text: $entry.groupId)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .help("Entra group ID (UUID)")
                }

                Button(action: onDelete) {
                    Image(systemName: "minus.circle.fill")
                        .foregroundStyle(.red.opacity(0.6))
                }
                .buttonStyle(.borderless)
            }

            if entry.type == .rbacRole {
                HStack(spacing: 8) {
                    Text("Role Def ID")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .frame(width: 80, alignment: .trailing)
                    TextField("UUID (e.g. 73c42c96-…)", text: $entry.roleDefinitionId)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .help("Role definition UUID")
                }
            }

            HStack(spacing: 8) {
                Text("Display Name")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(width: 80, alignment: .trailing)
                TextField("Optional label", text: Binding(
                    get: { entry.displayName ?? "" },
                    set: { entry.displayName = $0.isEmpty ? nil : $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.caption)

                Text("Duration")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                TextField("PT8H", text: Binding(
                    get: { entry.duration ?? "" },
                    set: { entry.duration = $0.isEmpty ? nil : $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .frame(width: 70)
                .help("ISO 8601 duration, e.g. PT8H")
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}


// MARK: - Previews

#Preview("Edit profile — my-app") {
    ProfileEditorView(profile: MockProfiles.myApp, isNew: false)
}

#Preview("Edit profile — backend") {
    ProfileEditorView(profile: MockProfiles.backend, isNew: false)
}

#Preview("New profile") {
    ProfileEditorView(profile: Profile(name: "", repoUrl: ""), isNew: true)
}
