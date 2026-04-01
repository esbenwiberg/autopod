import SwiftUI

/// Profile editor — create or edit a profile. Fields grouped into collapsible sections.
public struct ProfileEditorView: View {
    @State public var profile: Profile
    public let isNew: Bool
    public init(profile: Profile, isNew: Bool) {
        self._profile = State(initialValue: profile)
        self.isNew = isNew
    }

    @Environment(\.dismiss) private var dismiss

    public var body: some View {
        VStack(spacing: 0) {
            // Header
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

            Divider()

            // Form
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    // Core
                    editorSection("Basics", icon: "info.circle", expanded: true) {
                        if isNew {
                            fieldRow("Name") {
                                TextField("my-app", text: $profile.name)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.callout, design: .monospaced))
                            }
                        }
                        fieldRow("Repository URL") {
                            TextField("https://github.com/org/repo.git", text: $profile.repoUrl)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.callout, design: .monospaced))
                        }
                        fieldRow("Default Branch") {
                            TextField("main", text: $profile.defaultBranch)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 150)
                        }
                        fieldRow("Template") {
                            Picker("", selection: $profile.template) {
                                ForEach(StackTemplate.allCases, id: \.self) { t in
                                    Text(t.label).tag(t)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 200)
                        }
                    }

                    // Build & Run
                    editorSection("Build & Run", icon: "hammer") {
                        fieldRow("Build Command") {
                            TextField("npm run build", text: $profile.buildCommand)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.callout, design: .monospaced))
                        }
                        fieldRow("Start Command") {
                            TextField("npm start", text: $profile.startCommand)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.callout, design: .monospaced))
                        }
                        fieldRow("Test Command") {
                            TextField("Optional", text: Binding(
                                get: { profile.testCommand ?? "" },
                                set: { profile.testCommand = $0.isEmpty ? nil : $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                        }
                        fieldRow("Health Path") {
                            TextField("/", text: $profile.healthPath)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 150)
                        }
                        HStack(spacing: 16) {
                            fieldRow("Health Timeout") {
                                Stepper("\(profile.healthTimeout)s", value: $profile.healthTimeout, in: 10...600, step: 10)
                                    .frame(width: 120)
                            }
                            fieldRow("Build Timeout") {
                                Stepper("\(profile.buildTimeout)s", value: $profile.buildTimeout, in: 60...1800, step: 30)
                                    .frame(width: 120)
                            }
                            fieldRow("Test Timeout") {
                                Stepper("\(profile.testTimeout)s", value: $profile.testTimeout, in: 60...3600, step: 60)
                                    .frame(width: 120)
                            }
                        }
                    }

                    // Agent
                    editorSection("Agent", icon: "cpu") {
                        HStack(spacing: 16) {
                            fieldRow("Default Model") {
                                Picker("", selection: $profile.defaultModel) {
                                    Text("Opus").tag("opus")
                                    Text("Sonnet").tag("sonnet")
                                }
                                .labelsHidden()
                                .frame(width: 120)
                            }
                            fieldRow("Runtime") {
                                Picker("", selection: $profile.defaultRuntime) {
                                    ForEach(RuntimeType.allCases, id: \.self) { r in
                                        Text(r.rawValue).tag(r)
                                    }
                                }
                                .labelsHidden()
                                .frame(width: 120)
                            }
                            fieldRow("Max Validation") {
                                Stepper("\(profile.maxValidationAttempts)", value: $profile.maxValidationAttempts, in: 1...10)
                                    .frame(width: 100)
                            }
                        }
                        fieldRow("Custom Instructions") {
                            TextEditor(text: Binding(
                                get: { profile.customInstructions ?? "" },
                                set: { profile.customInstructions = $0.isEmpty ? nil : $0 }
                            ))
                            .font(.system(.caption, design: .monospaced))
                            .frame(height: 80)
                            .padding(4)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                            )
                        }
                    }

                    // Infrastructure
                    editorSection("Infrastructure", icon: "server.rack") {
                        HStack(spacing: 16) {
                            fieldRow("Execution Target") {
                                Picker("", selection: $profile.executionTarget) {
                                    ForEach(ExecutionTarget.allCases, id: \.self) { t in
                                        Text(t.label).tag(t)
                                    }
                                }
                                .labelsHidden()
                                .frame(width: 220)
                            }
                            fieldRow("Memory Limit") {
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
                        HStack(spacing: 16) {
                            fieldRow("Model Provider") {
                                Picker("", selection: $profile.modelProvider) {
                                    ForEach(ModelProvider.allCases, id: \.self) { p in
                                        Text(p.rawValue).tag(p)
                                    }
                                }
                                .labelsHidden()
                                .frame(width: 140)
                            }
                            fieldRow("PR Provider") {
                                Picker("", selection: $profile.prProvider) {
                                    ForEach(PRProvider.allCases, id: \.self) { p in
                                        Text(p.label).tag(p)
                                    }
                                }
                                .labelsHidden()
                                .frame(width: 140)
                            }
                        }
                    }

                    // Network
                    editorSection("Network Policy", icon: "shield.checkered") {
                        Toggle("Enable network isolation", isOn: $profile.networkEnabled)
                        if profile.networkEnabled {
                            fieldRow("Mode") {
                                Picker("", selection: $profile.networkMode) {
                                    ForEach(NetworkPolicyMode.allCases, id: \.self) { m in
                                        Text(m.label).tag(m)
                                    }
                                }
                                .labelsHidden()
                                .frame(width: 160)
                            }
                            if profile.networkMode == .restricted {
                                fieldRow("Allowed Hosts") {
                                    VStack(alignment: .leading, spacing: 4) {
                                        ForEach(profile.allowedHosts.indices, id: \.self) { i in
                                            HStack {
                                                TextField("hostname", text: $profile.allowedHosts[i])
                                                    .textFieldStyle(.roundedBorder)
                                                    .font(.system(.caption, design: .monospaced))
                                                Button {
                                                    profile.allowedHosts.remove(at: i)
                                                } label: {
                                                    Image(systemName: "minus.circle")
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

                    // Smoke pages
                    editorSection("Smoke Pages", icon: "globe") {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(profile.smokePages.indices, id: \.self) { i in
                                HStack {
                                    TextField("/path", text: $profile.smokePages[i].path)
                                        .textFieldStyle(.roundedBorder)
                                        .font(.system(.caption, design: .monospaced))
                                    Button {
                                        profile.smokePages.remove(at: i)
                                    } label: {
                                        Image(systemName: "minus.circle")
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

                    // Credentials
                    editorSection("Credentials", icon: "key") {
                        credentialRow("GitHub PAT", isSet: profile.hasGithubPat)
                        credentialRow("ADO PAT", isSet: profile.hasAdoPat)
                        credentialRow("Registry PAT", isSet: profile.hasRegistryPat)
                        Text("Credentials are encrypted at rest. Edit via daemon API.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }

                    // Injections summary
                    editorSection("Injections", icon: "syringe") {
                        HStack(spacing: 20) {
                            injectionStat("MCP Servers", count: profile.mcpServerCount, icon: "server.rack")
                            injectionStat("CLAUDE.md Sections", count: profile.claudeMdSectionCount, icon: "doc.text")
                            injectionStat("Skills", count: profile.skillCount, icon: "bolt.fill")
                        }
                        Text("Edit injections via CLI or daemon API.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(24)
            }

            Divider()

            // Actions
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
        .frame(width: 650, height: 680)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Section builder

    @ViewBuilder
    private func editorSection<Content: View>(
        _ title: String, icon: String, expanded: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        DisclosureGroup(isExpanded: .constant(true)) {
            VStack(alignment: .leading, spacing: 12) {
                content()
            }
            .padding(.top, 6)
            .padding(.bottom, 12)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(.blue)
                Text(title)
                    .font(.system(.subheadline).weight(.semibold))
            }
        }
        Divider()
    }

    // MARK: - Field row

    private func fieldRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }

    // MARK: - Credential row

    private func credentialRow(_ label: String, isSet: Bool) -> some View {
        HStack {
            Text(label)
                .font(.callout)
            Spacer()
            if isSet {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Configured")
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
            } else {
                Text("Not set")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Injection stat

    private func injectionStat(_ label: String, count: Int, icon: String) -> some View {
        VStack(spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text("\(count)")
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
            }
            .foregroundStyle(count > 0 ? .primary : .tertiary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
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
