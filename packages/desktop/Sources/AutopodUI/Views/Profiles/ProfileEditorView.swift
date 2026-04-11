import AutopodClient
import SwiftUI

// MARK: - Profile section navigation

enum ProfileSection: String, CaseIterable, Identifiable {
    case general
    case buildRun
    case agent
    case escalation
    case infrastructure
    case network
    case actions
    case validation
    case credentials
    case injections
    case memory

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general:        "General"
        case .buildRun:       "Build & Run"
        case .agent:          "Agent"
        case .escalation:     "Escalation"
        case .infrastructure: "Infrastructure"
        case .network:        "Network & Security"
        case .actions:        "Actions"
        case .validation:     "Validation"
        case .credentials:    "Credentials"
        case .injections:     "Injections"
        case .memory:         "Memory"
        }
    }

    var icon: String {
        switch self {
        case .general:        "info.circle"
        case .buildRun:       "hammer"
        case .agent:          "cpu"
        case .escalation:     "bubble.left.and.exclamationmark.bubble.right"
        case .infrastructure: "server.rack"
        case .network:        "shield.checkered"
        case .actions:        "bolt.shield"
        case .validation:     "globe"
        case .credentials:    "key"
        case .injections:     "syringe"
        case .memory:         "brain"
        }
    }

    var description: String {
        switch self {
        case .general:
            "Core identity and repository settings for this profile."
        case .buildRun:
            "Commands executed inside the container to build, test, and run the application."
        case .agent:
            "AI model and runtime configuration for code generation sessions."
        case .escalation:
            "Controls how and when the agent escalates to humans or other AI models."
        case .infrastructure:
            "Execution environment, resource limits, and service provider configuration."
        case .network:
            "Outbound network access controls for container isolation."
        case .actions:
            "Control plane actions the agent can execute — GitHub, ADO, Azure, and custom HTTP."
        case .validation:
            "Smoke test pages loaded after the app starts to verify correctness."
        case .credentials:
            "Authentication tokens for Git providers and package registries. Encrypted at rest."
        case .injections:
            "Additional tools, documentation, and commands injected into agent containers."
        case .memory:
            "Persistent memory entries injected into agent sessions for this profile. Agents can suggest new memories via memory_suggest."
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

    public init(profile: Profile, isNew: Bool,
                actionCatalog: [ActionCatalogItem] = [],
                onSave: ((Profile) -> Void)? = nil,
                onAuthenticate: ProfileAuthHandler? = nil,
                memoryEntries: [MemoryEntry] = [],
                onApproveMemory: @escaping (String) -> Void = { _ in },
                onRejectMemory: @escaping (String) -> Void = { _ in },
                onDeleteMemory: @escaping (String) -> Void = { _ in }) {
        self._profile = State(initialValue: profile)
        self.isNew = isNew
        self.actionCatalog = actionCatalog
        self.onSave = onSave
        self.onAuthenticate = onAuthenticate
        self.memoryEntries = memoryEntries
        self.onApproveMemory = onApproveMemory
        self.onRejectMemory = onRejectMemory
        self.onDeleteMemory = onDeleteMemory
    }

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSection: ProfileSection = .general
    @State private var authStatus: AuthStatus?

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
        .frame(width: 860, height: 700)
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
        VStack(spacing: 1) {
            ForEach(ProfileSection.allCases) { section in
                Button {
                    withAnimation(.easeOut(duration: 0.15)) {
                        selectedSection = section
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
            Spacer()
        }
        .padding(10)
        .frame(width: 180)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    // MARK: - Section content

    private var sectionContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeader(selectedSection)

                switch selectedSection {
                case .general:        generalFields
                case .buildRun:       buildRunFields
                case .agent:          agentFields
                case .escalation:     escalationFields
                case .infrastructure: infrastructureFields
                case .network:        networkFields
                case .actions:        actionFields
                case .validation:     validationFields
                case .credentials:    credentialFields
                case .injections:     injectionFields
                case .memory:         memorySection
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
        fieldRow("Default Branch", help: "Base branch for worktrees. Feature branches are created off this.") {
            TextField("main", text: $profile.defaultBranch)
                .textFieldStyle(.roundedBorder)
                .frame(width: 180)
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
            fieldRow("Output Mode", help: "How the session delivers results — PR creates a pull request, Artifact collects output files, Workspace is interactive.") {
                Picker("", selection: $profile.outputMode) {
                    ForEach(OutputMode.allCases, id: \.self) { m in
                        Text(m.label).tag(m)
                    }
                }
                .labelsHidden()
                .frame(width: 180)
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

        fieldRow("Worker Profile", help: "Profile to use when launching worker sessions from a workspace pod using this profile.") {
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
                fieldRow("Max Calls", help: "Maximum number of AI consultations per session before forcing human escalation.") {
                    Stepper("\(profile.escalationAskAiMaxCalls)", value: $profile.escalationAskAiMaxCalls, in: 1...20)
                        .frame(width: 110)
                }
            }
        }

        Divider().padding(.vertical, 4)

        Text("Guardrails")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        HStack(spacing: 24) {
            fieldRow("Auto-pause After", help: "Number of escalation attempts before the session is automatically paused. Prevents runaway loops.") {
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
    }

    // MARK: - Infrastructure

    @ViewBuilder
    private var infrastructureFields: some View {
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

        Divider().padding(.vertical, 4)

        Text("Providers")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)

        HStack(spacing: 24) {
            fieldRow("Model Provider", help: "Authentication method for the AI model API.") {
                Picker("", selection: $profile.modelProvider) {
                    ForEach(ModelProvider.allCases, id: \.self) { p in
                        Text(p.rawValue.capitalized).tag(p)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
            }
            fieldRow("PR Provider", help: "Service where pull requests are created and managed.") {
                Picker("", selection: $profile.prProvider) {
                    ForEach(PRProvider.allCases, id: \.self) { p in
                        Text(p.label).tag(p)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
            }
        }

        // Provider credentials indicator
        if let credType = profile.providerCredentialsType {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text("Provider credentials configured: \(credType)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 2)
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

    // MARK: - Actions

    @ViewBuilder
    private var actionFields: some View {
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
                                .help("Completely disable this action for sessions using this profile")
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
            // Fallback when catalog is unavailable — show classic group checkboxes
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
                // Group is on — remove the disabled override
                profile.actionOverrides.removeAll { $0.action == name && $0.disabled }
            } else {
                // Group is off — add to individual enabledActions
                profile.actionEnabledActions.insert(name)
            }
        } else {
            if profile.actionEnabledGroups.contains(group) {
                // Group is on — add disabled override to suppress this one
                if !profile.actionOverrides.contains(where: { $0.action == name }) {
                    profile.actionOverrides.append(ActionOverride(action: name, disabled: true))
                } else {
                    // Update existing override
                    if let idx = profile.actionOverrides.firstIndex(where: { $0.action == name }) {
                        profile.actionOverrides[idx].disabled = true
                    }
                }
            } else {
                // Group is off — remove from individual enabledActions
                profile.actionEnabledActions.remove(name)
            }
        }
    }

    private func toggleGroup(_ group: ActionGroup, items: [ActionCatalogItem], enabled: Bool) {
        if enabled {
            profile.actionEnabledGroups.insert(group)
            // Clean up: remove individual enabledActions that are now covered by the group
            for item in items {
                profile.actionEnabledActions.remove(item.name)
            }
            // Clean up: remove disabled overrides for this group's actions
            profile.actionOverrides.removeAll { o in
                o.disabled && items.contains { $0.name == o.action }
            }
        } else {
            profile.actionEnabledGroups.remove(group)
            // Don't auto-add individual actions — clean disable
        }
    }

    @ViewBuilder
    private func actionNamePicker(selection: Binding<String>) -> some View {
        if actionCatalog.isEmpty {
            // Fallback to text field when catalog unavailable
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

    // MARK: - Validation

    @ViewBuilder
    private var validationFields: some View {
        fieldRow("Max Attempts", help: "How many times the agent can retry after a failed smoke test before the session is marked failed.") {
            Stepper("\(profile.maxValidationAttempts)", value: $profile.maxValidationAttempts, in: 1...10)
                .frame(width: 120)
        }

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
    }

    // MARK: - Credentials

    @ViewBuilder
    private var credentialFields: some View {
        // Model provider authentication
        if !isNew {
            VStack(alignment: .leading, spacing: 8) {
                Text("Model Provider Auth")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
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

                // Status feedback
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
        }

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
            onDelete: onDeleteMemory
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
