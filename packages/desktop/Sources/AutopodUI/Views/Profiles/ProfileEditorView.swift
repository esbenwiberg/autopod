import SwiftUI

// MARK: - Profile section navigation

enum ProfileSection: String, CaseIterable, Identifiable {
    case general
    case buildRun
    case agent
    case infrastructure
    case network
    case validation
    case credentials
    case injections

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general:        "General"
        case .buildRun:       "Build & Run"
        case .agent:          "Agent"
        case .infrastructure: "Infrastructure"
        case .network:        "Network & Security"
        case .validation:     "Validation"
        case .credentials:    "Credentials"
        case .injections:     "Injections"
        }
    }

    var icon: String {
        switch self {
        case .general:        "info.circle"
        case .buildRun:       "hammer"
        case .agent:          "cpu"
        case .infrastructure: "server.rack"
        case .network:        "shield.checkered"
        case .validation:     "globe"
        case .credentials:    "key"
        case .injections:     "syringe"
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
        case .infrastructure:
            "Execution environment, resource limits, and service provider configuration."
        case .network:
            "Outbound network access controls for container isolation."
        case .validation:
            "Smoke test pages loaded after the app starts to verify correctness."
        case .credentials:
            "Authentication tokens for Git providers and package registries. Encrypted at rest."
        case .injections:
            "Additional tools, documentation, and commands injected into agent containers."
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

/// Profile editor — settings-style layout with sidebar section navigation and inline help.
public struct ProfileEditorView: View {
    @State public var profile: Profile
    public let isNew: Bool

    public init(profile: Profile, isNew: Bool) {
        self._profile = State(initialValue: profile)
        self.isNew = isNew
    }

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSection: ProfileSection = .general

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
        .frame(width: 860, height: 660)
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
                case .infrastructure: infrastructureFields
                case .network:        networkFields
                case .validation:     validationFields
                case .credentials:    credentialFields
                case .injections:     injectionFields
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
            Button(isNew ? "Create" : "Save") { dismiss() }
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
        fieldRow("Template", help: "Container image and toolchain — determines pre-installed runtimes and build tools.") {
            Picker("", selection: $profile.template) {
                ForEach(StackTemplate.allCases, id: \.self) { t in
                    Text(t.label).tag(t)
                }
            }
            .labelsHidden()
            .frame(width: 220)
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
