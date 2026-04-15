import SwiftUI
import AutopodClient

/// Modal sheet for creating a new session.
public struct CreateSessionSheet: View {
    @Binding public var isPresented: Bool
    public var actions: SessionActions
    public var profileNames: [String]
    public init(
        isPresented: Binding<Bool>,
        actions: SessionActions = .preview,
        profileNames: [String] = ["my-app", "webapp", "backend"]
    ) {
        self._isPresented = isPresented
        self.actions = actions
        self.profileNames = profileNames
    }

    @State private var selectedProfile = "my-app"
    @State private var task = ""
    @State private var modelText = ""
    @State private var outputMode = "pr"
    @State private var baseBranch = ""
    @State private var acFromPath = ""
    @State private var criteria: [String] = [""]
    @State private var showBulkImport = false
    @State private var bulkText = ""
    @State private var pimGroups: [PimGroupRequest] = []
    @State private var showAdvanced = false

    private var profiles: [String] { profileNames.isEmpty ? ["my-app"] : profileNames }
    private let outputs = [("pr", "Worker (PR)"), ("workspace", "Workspace (Interactive)"), ("artifact", "Artifact")]

    private var isWorkspace: Bool { outputMode == "workspace" }
    private var canCreate: Bool {
        isWorkspace || !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("New Session")
                    .font(.headline)
                Spacer()
                Button {
                    isPresented = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                        .font(.title3)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            Divider()

            // Form
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // Profile
                    formSection("Profile") {
                        Picker("", selection: $selectedProfile) {
                            ForEach(profiles, id: \.self) { p in
                                Text(p).tag(p)
                            }
                        }
                        .labelsHidden()
                    }

                    // Type + Model
                    HStack(alignment: .top, spacing: 16) {
                        formSection("Type") {
                            Picker("", selection: $outputMode) {
                                ForEach(outputs, id: \.0) { value, label in
                                    Text(label).tag(value)
                                }
                            }
                            .labelsHidden()
                        }
                        if !isWorkspace {
                            formSection("Model (optional)") {
                                HStack(spacing: 6) {
                                    Image(systemName: "cpu")
                                        .foregroundStyle(.tertiary)
                                        .font(.system(size: 11))
                                    TextField("profile default", text: $modelText)
                                        .textFieldStyle(.plain)
                                        .font(.system(.callout, design: .monospaced))
                                }
                                .padding(8)
                                .background(Color(nsColor: .controlBackgroundColor))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }

                    if isWorkspace {
                        // Workspace info
                        HStack(spacing: 6) {
                            Image(systemName: "info.circle")
                                .foregroundStyle(.teal)
                            Text("Workspace pods are interactive — no agent, no task. You'll get a shell to work in.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .background(.teal.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    // Task (not for workspace)
                    if !isWorkspace {
                        formSection("Task") {
                            TextEditor(text: $task)
                                .font(.system(.body, design: .default))
                                .frame(minHeight: 80, maxHeight: 150)
                                .padding(6)
                                .background(Color(nsColor: .controlBackgroundColor))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                                )
                                .overlay(alignment: .topLeading) {
                                    if task.isEmpty {
                                        Text("Describe what the agent should build...")
                                            .font(.body)
                                            .foregroundStyle(.tertiary)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 12)
                                            .allowsHitTesting(false)
                                    }
                                }
                        }
                    }

                    // Base branch (optional — for workspace handoff)
                    if !isWorkspace {
                        formSection("Base Branch (optional)") {
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.branch")
                                    .foregroundStyle(.tertiary)
                                    .font(.system(size: 11))
                                TextField("main", text: $baseBranch)
                                    .textFieldStyle(.plain)
                                    .font(.system(.callout, design: .monospaced))
                            }
                            .padding(8)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }

                    // AC from file (optional)
                    if !isWorkspace {
                        formSection("AC File Path (optional)") {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.tertiary)
                                    .font(.system(size: 11))
                                TextField("e.g. specs/auth-ac.md", text: $acFromPath)
                                    .textFieldStyle(.plain)
                                    .font(.system(.callout, design: .monospaced))
                            }
                            .padding(8)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }

                    // Acceptance criteria (manual — only for worker/artifact, and only if no AC file)
                    if !isWorkspace && acFromPath.isEmpty {
                    formSection("Acceptance Criteria") {
                        VStack(alignment: .leading, spacing: 6) {
                            if showBulkImport {
                                TextEditor(text: $bulkText)
                                    .font(.system(.callout, design: .monospaced))
                                    .frame(minHeight: 100, maxHeight: 180)
                                    .padding(6)
                                    .background(Color(nsColor: .controlBackgroundColor))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                                    )
                                    .overlay(alignment: .topLeading) {
                                        if bulkText.isEmpty {
                                            Text("Paste your list here...\n- Item one\n- Item two")
                                                .font(.system(.callout, design: .monospaced))
                                                .foregroundStyle(.tertiary)
                                                .padding(.horizontal, 10)
                                                .padding(.vertical, 12)
                                                .allowsHitTesting(false)
                                        }
                                    }
                                HStack(spacing: 8) {
                                    Button("Import") {
                                        let parsed = Self.parseAcList(bulkText)
                                        if !parsed.isEmpty {
                                            criteria = parsed
                                        }
                                        bulkText = ""
                                        showBulkImport = false
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.small)
                                    .disabled(bulkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                    Button("Cancel") {
                                        bulkText = ""
                                        showBulkImport = false
                                    }
                                    .controlSize(.small)
                                }
                            } else {
                                ForEach(criteria.indices, id: \.self) { index in
                                    HStack(spacing: 6) {
                                        Image(systemName: "checkmark.square")
                                            .foregroundStyle(.tertiary)
                                            .font(.system(size: 12))
                                        TextField("Criterion \(index + 1)", text: $criteria[index])
                                            .textFieldStyle(.plain)
                                            .font(.callout)
                                        if criteria.count > 1 {
                                            Button {
                                                criteria.remove(at: index)
                                            } label: {
                                                Image(systemName: "minus.circle")
                                                    .foregroundStyle(.red.opacity(0.6))
                                                    .font(.system(size: 12))
                                            }
                                            .buttonStyle(.borderless)
                                        }
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 5)
                                    .background(Color(nsColor: .controlBackgroundColor))
                                    .clipShape(RoundedRectangle(cornerRadius: 4))
                                }
                                HStack(spacing: 12) {
                                    Button {
                                        criteria.append("")
                                    } label: {
                                        Label("Add criterion", systemImage: "plus")
                                            .font(.caption)
                                    }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.blue)
                                    Button {
                                        showBulkImport = true
                                    } label: {
                                        Label("Paste list", systemImage: "doc.on.clipboard")
                                            .font(.caption)
                                    }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.blue)
                                }
                            }
                        }
                    }

                    Text("Optional — helps the agent validate its own work")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    } // end if !isWorkspace

                    // Advanced options (PIM groups)
                    if !isWorkspace {
                        DisclosureGroup(isExpanded: $showAdvanced) {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text("Azure PIM Groups")
                                        .font(.system(.caption).weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    HelpBadge(text: "PIM groups activated at session start. The agent can use activate_pim_group / deactivate_pim_group actions during the session. Requires the Azure PIM action group to be enabled in the profile.")
                                    Spacer()
                                    Button {
                                        pimGroups.append(PimGroupRequest())
                                    } label: {
                                        Label("Add group", systemImage: "plus")
                                            .font(.caption)
                                    }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.blue)
                                }

                                if pimGroups.isEmpty {
                                    Text("No PIM groups — add one to activate privileged access at session start.")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                } else {
                                    ForEach($pimGroups) { $group in
                                        VStack(alignment: .leading, spacing: 6) {
                                            HStack(spacing: 6) {
                                                VStack(alignment: .leading, spacing: 4) {
                                                    TextField("Group ID (UUID)", text: $group.groupId)
                                                        .textFieldStyle(.roundedBorder)
                                                        .font(.system(.caption, design: .monospaced))
                                                    TextField("Display name (optional)", text: Binding(
                                                        get: { group.displayName ?? "" },
                                                        set: { group.displayName = $0.isEmpty ? nil : $0 }
                                                    ))
                                                    .textFieldStyle(.roundedBorder)
                                                    .font(.caption)
                                                    HStack(spacing: 6) {
                                                        TextField("Duration (e.g. PT8H)", text: Binding(
                                                            get: { group.duration ?? "" },
                                                            set: { group.duration = $0.isEmpty ? nil : $0 }
                                                        ))
                                                        .textFieldStyle(.roundedBorder)
                                                        .font(.system(.caption, design: .monospaced))
                                                        .frame(minWidth: 120)
                                                        TextField("Justification (optional)", text: Binding(
                                                            get: { group.justification ?? "" },
                                                            set: { group.justification = $0.isEmpty ? nil : $0 }
                                                        ))
                                                        .textFieldStyle(.roundedBorder)
                                                        .font(.caption)
                                                    }
                                                }
                                                Button {
                                                    pimGroups.removeAll { $0.id == group.id }
                                                } label: {
                                                    Image(systemName: "minus.circle.fill")
                                                        .foregroundStyle(.red.opacity(0.6))
                                                }
                                                .buttonStyle(.borderless)
                                            }
                                            Divider()
                                        }
                                    }
                                }
                            }
                            .padding(.top, 8)
                        } label: {
                            Text("Advanced")
                                .font(.system(.caption).weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(20)
            }

            Divider()

            // Actions
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button(isWorkspace ? "Create Workspace" : "Create Session") {
                    Task {
                        let ac = criteria.filter { !$0.isEmpty }
                        let model = modelText.trimmingCharacters(in: .whitespacesAndNewlines)
                        let pim = pimGroups.filter { !$0.groupId.isEmpty }
                        _ = await actions.createSession(
                            selectedProfile, task, model.isEmpty ? nil : model,
                            outputMode, ac.isEmpty ? nil : ac,
                            baseBranch.isEmpty ? nil : baseBranch,
                            acFromPath.isEmpty ? nil : acFromPath,
                            pim.isEmpty ? nil : pim
                        )
                        isPresented = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!canCreate)
            }
            .padding(16)
        }
        .frame(minWidth: 480, maxWidth: 480, minHeight: 580)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// Parse a newline-separated list, stripping common prefixes (`- `, `1. `, `a) `, etc.).
    static func parseAcList(_ text: String) -> [String] {
        // Mirrors packages/shared/src/parse-ac-list.ts
        let prefix = /^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|[a-zA-Z][.)]\s+)/
        return text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .map { $0.replacing(prefix, with: "") }
            .filter { !$0.isEmpty }
    }

    private func formSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}

// MARK: - Preview

#Preview("Create session") {
    @Previewable @State var show = true
    CreateSessionSheet(isPresented: $show)
}
