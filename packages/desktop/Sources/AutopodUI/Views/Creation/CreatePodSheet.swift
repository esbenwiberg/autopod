import SwiftUI
import AutopodClient

/// Modal sheet for creating a new pod.
public struct CreateSessionSheet: View {
    @Binding public var isPresented: Bool
    public var actions: PodActions
    public var profileNames: [String]
    /// Full profile objects for the selection list. Optional — when provided,
    /// the sheet uses these to drive per-profile UI (e.g. surfacing the Dagger
    /// sidecar auto-attach badge for trusted profiles with Dagger enabled).
    /// When empty, only `profileNames` is used and profile-gated controls
    /// stay hidden.
    public var profileDetails: [Profile]
    public init(
        isPresented: Binding<Bool>,
        actions: PodActions = .preview,
        profileNames: [String] = ["my-app", "webapp", "backend"],
        profileDetails: [Profile] = []
    ) {
        self._isPresented = isPresented
        self.actions = actions
        self.profileNames = profileNames
        self.profileDetails = profileDetails
    }

    @State private var selectedProfile = "my-app"
    @State private var task = ""
    @State private var modelText = ""
    @State private var agentMode: String = "auto"
    @State private var outputTarget: String = "pr"
    @State private var validate: Bool = true
    @State private var baseBranch = ""
    @State private var acFromPath = ""
    @State private var criteria: [AcDefinition] = [AcDefinition()]
    @State private var showBulkImport = false
    @State private var bulkText = ""
    @State private var pimGroups: [PimGroupRequest] = []
    @State private var showAdvanced = false
    @State private var refProfileNames: Set<String> = []
    @State private var adHocRefUrls: [String] = []

    private var profiles: [String] { profileNames.isEmpty ? ["my-app"] : profileNames }

    /// Selected profile's full config, if available. `profileDetails` is
    /// optional so previews / callers that only pass names still work.
    private var selectedProfileDetail: Profile? {
        profileDetails.first { $0.name == selectedProfile }
    }

    /// True when the selected profile auto-attaches a Dagger engine sidecar
    /// to every pod. Mirrors the daemon's `getAutoAttachedSidecars` rule:
    ///  - `trustedSource` — the privileged-sidecar trust gate
    ///  - `sidecars.dagger.enabled` — the engine image/version is configured
    /// When true, the sheet shows a read-only badge so the user knows their
    /// pod will boot with a Dagger engine attached. Sub-profiles disable it
    /// by overriding either flag.
    private var profileAutoAttachesDagger: Bool {
        guard let p = selectedProfileDetail else { return false }
        return p.trustedSource && (p.sidecars?.dagger?.enabled ?? false)
    }
    private let agentModes = [("auto", "Agent"), ("interactive", "Interactive")]
    private let outputTargets = [
        ("pr", "Pull Request"),
        ("branch", "Branch Push"),
        ("artifact", "Artifact"),
        ("none", "Ephemeral"),
    ]

    private var isInteractive: Bool { agentMode == "interactive" }
    private var canCreate: Bool {
        isInteractive || !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Profiles eligible to be picked as reference repos: any profile other
    /// than the primary, that has a non-empty repoUrl.
    private var refRepoCandidates: [Profile] {
        profileDetails.filter { $0.name != selectedProfile && !$0.repoUrl.isEmpty }
    }

    /// Resolve the final `[ReferenceRepoRequest]` list from the two UI sources,
    /// deduping by URL while preserving order (profile chips first, then ad-hoc).
    /// Profile-picked entries carry `sourceProfile` so the daemon authenticates
    /// the clone with that profile's PAT; ad-hoc URLs clone unauthenticated.
    private func resolvedReferenceRepos() -> [ReferenceRepoRequest] {
        var seen: Set<String> = []
        var out: [ReferenceRepoRequest] = []
        for p in refRepoCandidates where refProfileNames.contains(p.name) {
            if seen.insert(p.repoUrl).inserted {
                out.append(ReferenceRepoRequest(url: p.repoUrl, sourceProfile: p.name))
            }
        }
        for raw in adHocRefUrls {
            let url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty else { continue }
            if seen.insert(url).inserted {
                out.append(ReferenceRepoRequest(url: url))
            }
        }
        return out
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("New Pod")
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

                    // Auto-attach badge — surfaces silently-spawned sidecars
                    // (currently just Dagger) so the user isn't surprised when
                    // pod startup spends ~10–30s pulling/booting the engine.
                    // Visible for both interactive and agent pods.
                    if profileAutoAttachesDagger {
                        HStack(spacing: 6) {
                            Image(systemName: "shippingbox.fill")
                                .foregroundStyle(.secondary)
                            Text("Dagger engine: auto-attached from profile")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HelpBadge(text: "This profile has trustedSource and sidecars.dagger.enabled, so every pod on it gets a privileged Dagger engine container. To opt out, use a sub-profile that sets sidecars.dagger.enabled:false or trustedSource:false.")
                            Spacer()
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(Color.secondary.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    // Agent + Output
                    HStack(alignment: .top, spacing: 16) {
                        formSection("Agent") {
                            Picker("", selection: $agentMode) {
                                ForEach(agentModes, id: \.0) { value, label in
                                    Text(label).tag(value)
                                }
                            }
                            .labelsHidden()
                            .onChange(of: agentMode) { _, newValue in
                                if newValue == "interactive" {
                                    // Interactive pods default to branch-push on complete
                                    if outputTarget == "pr" { outputTarget = "branch" }
                                    validate = false
                                } else {
                                    if outputTarget == "none" || outputTarget == "branch" {
                                        outputTarget = "pr"
                                    }
                                    validate = true
                                }
                            }
                        }
                        formSection("Output") {
                            Picker("", selection: $outputTarget) {
                                ForEach(outputTargets, id: \.0) { value, label in
                                    Text(label).tag(value)
                                }
                            }
                            .labelsHidden()
                        }
                    }

                    // Validate toggle + Model
                    HStack(alignment: .top, spacing: 16) {
                        formSection("Validate") {
                            Toggle(isOn: $validate) {
                                Text(validate ? "Run build / smoke / review" : "Skip validation")
                                    .font(.callout)
                            }
                            .toggleStyle(.switch)
                            .controlSize(.small)
                        }
                        if !isInteractive {
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

                    if isInteractive {
                        // Interactive info
                        HStack(spacing: 6) {
                            Image(systemName: "info.circle")
                                .foregroundStyle(.teal)
                            Text("Interactive pods have no agent. You drive the container. Promote later with Complete → PR to hand off.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .background(.teal.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 6))

                        // Reference Repos is the primary configuration for interactive
                        // pods (no Task / AC / sidecars / PIM apply), so surface it as a
                        // top-level section instead of burying it in Advanced.
                        VStack(alignment: .leading, spacing: 10) {
                            referenceReposSection()
                        }
                    }

                    // Task (not for interactive)
                    if !isInteractive {
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
                    if !isInteractive {
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
                    if !isInteractive {
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
                    if !isInteractive && acFromPath.isEmpty {
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
                                            criteria = parsed.map { AcDefinition.fromString($0) }
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
                                ForEach($criteria) { $c in
                                    criterionRow($c)
                                }
                                HStack(spacing: 12) {
                                    Button {
                                        criteria.append(AcDefinition())
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
                    } // end if !isInteractive

                    // Advanced options — agent-mode only. Reference Repos lives top-level
                    // for interactive pods; PIM is agent-only and would leave an empty
                    // disclosure in interactive mode. Dagger sidecar attachment is
                    // surfaced as a top-level badge above (auto-attached from profile),
                    // so it doesn't need a slot here anymore.
                    if !isInteractive {
                    DisclosureGroup(isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: 10) {
                            if !isInteractive {
                                HStack {
                                    Text("Azure PIM Groups")
                                        .font(.system(.caption).weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    HelpBadge(text: "PIM groups activated at pod start. The agent can use activate_pim_group / deactivate_pim_group actions during the pod. Requires the Azure PIM action group to be enabled in the profile.")
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
                                    Text("No PIM groups — add one to activate privileged access at pod start.")
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

                                Divider()
                            } // end agent-only Advanced sub-sections

                            // Agent-mode: Reference Repos lives inside Advanced.
                            // Interactive-mode: rendered top-level above the Advanced
                            // disclosure, so it doesn't double-render here.
                            if !isInteractive {
                                referenceReposSection()
                            }
                        }
                        .padding(.top, 8)
                    } label: {
                        Text("Advanced")
                            .font(.system(.caption).weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    } // end if !isInteractive — Advanced is agent-mode only
                }
                .padding(20)
            }

            Divider()

            // Actions
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button(isInteractive ? "Create Workspace" : "Create Pod") {
                    Task {
                        let ac = criteria.filter { !$0.test.trimmingCharacters(in: .whitespaces).isEmpty }
                        let model = modelText.trimmingCharacters(in: .whitespacesAndNewlines)
                        let pim = pimGroups.filter { !$0.groupId.isEmpty }
                        let pod = PodConfigRequest(
                            agentMode: agentMode,
                            output: outputTarget,
                            validate: validate,
                            promotable: isInteractive
                        )
                        // Sidecars are auto-attached server-side based on profile
                        // config; no need to set them per-pod from this sheet.
                        // Briefs and CLI can still pass requireSidecars for
                        // additive opt-in to non-auto-attached sidecars.
                        let refs = resolvedReferenceRepos()
                        _ = await actions.createPod(
                            selectedProfile, task, model.isEmpty ? nil : model,
                            pod, ac.isEmpty ? nil : ac,
                            baseBranch.isEmpty ? nil : baseBranch,
                            acFromPath.isEmpty ? nil : acFromPath,
                            pim.isEmpty ? nil : pim,
                            nil,
                            refs.isEmpty ? nil : refs
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

    @ViewBuilder
    private func criterionRow(_ binding: Binding<AcDefinition>) -> some View {
        let c = binding.wrappedValue
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                // Type picker
                Picker("", selection: binding.type) {
                    ForEach(AcDefinition.AcType.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .frame(width: 90)
                .controlSize(.small)

                // Test / description
                TextField(c.type == .none ? "Describe the criterion" : c.type == .api ? "curl / endpoint to probe" : "page path or selector to check", text: binding.test)
                    .textFieldStyle(.plain)
                    .font(.callout)

                if criteria.count > 1, let idx = criteria.firstIndex(where: { $0.id == c.id }) {
                    Button {
                        criteria.remove(at: idx)
                    } label: {
                        Image(systemName: "minus.circle")
                            .foregroundStyle(.red.opacity(0.6))
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.borderless)
                }
            }
            if c.type != .none {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark").foregroundStyle(.green).font(.system(size: 9))
                    TextField("Pass condition", text: binding.pass)
                        .textFieldStyle(.plain)
                        .font(.caption)
                }
                HStack(spacing: 6) {
                    Image(systemName: "xmark").foregroundStyle(.red).font(.system(size: 9))
                    TextField("Fail condition", text: binding.fail)
                        .textFieldStyle(.plain)
                        .font(.caption)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 4))
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

    /// Reference Repos picker — same UI used for both interactive (top-level)
    /// and agent-mode (inside Advanced) call sites. Renders its own caption-
    /// weight title with HelpBadge, so callers don't need to wrap it in a
    /// `formSection` (doing so would duplicate the title).
    @ViewBuilder
    private func referenceReposSection() -> some View {
        // Reference repos — read-only mounts at /repos/<name>/.
        HStack {
            Text("Reference Repos")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)
            HelpBadge(text: "Read-only repos cloned into /repos/<name>/ alongside the primary worktree. Use for cross-repo audits, comparing implementations, or letting the agent reference docs/pipeline definitions while it works.")
            Spacer()
        }

        if refRepoCandidates.isEmpty && adHocRefUrls.isEmpty {
            Text("No other profiles available — add a URL below to attach an ad-hoc reference repo.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }

        if !refRepoCandidates.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("From profiles")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                ForEach(refRepoCandidates, id: \.name) { p in
                    Toggle(isOn: Binding(
                        get: { refProfileNames.contains(p.name) },
                        set: { isOn in
                            if isOn { refProfileNames.insert(p.name) }
                            else { refProfileNames.remove(p.name) }
                        }
                    )) {
                        HStack(spacing: 6) {
                            Text(p.name).font(.callout)
                            Text(p.repoUrl)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                }
            }
        }

        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Ad-hoc URLs")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                Button {
                    adHocRefUrls.append("")
                } label: {
                    Label("Add URL", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.blue)
            }
            ForEach(Array(adHocRefUrls.enumerated()), id: \.offset) { idx, _ in
                HStack(spacing: 6) {
                    TextField("https://github.com/org/repo", text: Binding(
                        get: { idx < adHocRefUrls.count ? adHocRefUrls[idx] : "" },
                        set: { newValue in
                            if idx < adHocRefUrls.count {
                                adHocRefUrls[idx] = newValue
                            }
                        }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    Button {
                        if idx < adHocRefUrls.count {
                            adHocRefUrls.remove(at: idx)
                        }
                    } label: {
                        Image(systemName: "minus.circle")
                            .foregroundStyle(.red.opacity(0.6))
                    }
                    .buttonStyle(.borderless)
                }
            }
        }

        Text("Profile-backed refs authenticate with that profile's PAT. Ad-hoc URLs clone unauthenticated — for private repos, add a profile and pick it above.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
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

#Preview("Create pod") {
    @Previewable @State var show = true
    CreateSessionSheet(isPresented: $show)
}
