import AppKit
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
    @State private var taskSource: TaskSource = .manual
    @State private var briefFolderPath = ""
    @State private var briefBranchPath = ""
    @State private var briefPreview: ParsedBriefResponse?
    @State private var isPreviewingBrief = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var modelText = ""
    @State private var agentMode: String = "auto"
    @State private var outputTarget: String = "pr"
    @State private var validate: Bool = true
    @State private var sourceBranch = ""
    @State private var baseBranch = ""
    @State private var branchPrefix = ""
    @State private var pimGroups: [PimGroupRequest] = []
    @State private var includeSpecFiles = false
    @State private var showAdvanced = false
    @State private var showInteractiveRefRepos = false
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
        if isSubmitting || selectedProfile.isEmpty { return false }
        if isInteractive { return true }
        switch taskSource {
        case .manual:
            return !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .localFolder, .onBranch:
            return briefPreview != nil
        }
    }

    private enum TaskSource: String, CaseIterable, Identifiable {
        case manual
        case localFolder
        case onBranch

        var id: String { rawValue }
        var label: String {
            switch self {
            case .manual:      "Manual task"
            case .localFolder: "Local folder"
            case .onBranch:    "Path on branch"
            }
        }
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
                        .onChange(of: selectedProfile) { _, _ in
                            if taskSource == .onBranch { clearBriefPreview() }
                        }
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
                                    taskSource = .manual
                                    clearBriefPreview()
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

                        // Reference Repos: collapsed by default. Most interactive pods
                        // don't pull in extra repos, and the long profile list dominated
                        // the sheet. Users who need it can expand to pick.
                        DisclosureGroup(isExpanded: $showInteractiveRefRepos) {
                            VStack(alignment: .leading, spacing: 10) {
                                referenceReposSection(showHeader: false)
                            }
                            .padding(.top, 8)
                        } label: {
                            HStack(spacing: 6) {
                                Text("Reference Repos")
                                    .font(.system(.caption).weight(.semibold))
                                    .foregroundStyle(.secondary)
                                HelpBadge(text: "Read-only repos cloned into /repos/<name>/ alongside the primary worktree. Use for cross-repo audits, comparing implementations, or letting the agent reference docs/pipeline definitions while it works.")
                            }
                        }
                    }

                    // Task (not for interactive)
                    if !isInteractive {
                        taskSourcePicker
                        taskInputSection
                        if let err = errorMessage {
                            Text(err)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.red.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }

                    // Target branch (optional). Branch-hosted specs can start
                    // from a separate source branch while still opening the PR here.
                    formSection(taskSource == .onBranch ? "Target Branch (optional)" : "Base Branch (optional)") {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.branch")
                                .foregroundStyle(.tertiary)
                                .font(.system(size: 11))
                            TextField("main", text: $baseBranch)
                                .textFieldStyle(.plain)
                                .font(.system(.callout, design: .monospaced))
                                .onChange(of: baseBranch) { _, _ in
                                    if taskSource == .onBranch { clearBriefPreview() }
                                }
                        }
                        .padding(8)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    // Branch prefix (optional — overrides profile default).
                    // Used to autogen the working branch name for both agent and
                    // interactive pods (`<prefix><podId>`).
                    formSection("Branch Prefix (optional)") {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.branch")
                                .foregroundStyle(.tertiary)
                                .font(.system(size: 11))
                            TextField(
                                selectedProfileDetail?.branchPrefix ?? "autopod/",
                                text: $branchPrefix
                            )
                            .textFieldStyle(.plain)
                            .font(.system(.callout, design: .monospaced))
                        }
                        .padding(8)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

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
                    Task { await submit() }
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

    private var taskSourcePicker: some View {
        formSection("Task Source") {
            Picker("", selection: $taskSource) {
                ForEach(TaskSource.allCases) { source in
                    Text(source.label).tag(source)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: taskSource) { _, _ in
                clearBriefPreview()
            }
        }
    }

    @ViewBuilder
    private var taskInputSection: some View {
        switch taskSource {
        case .manual:
            manualTaskSection
        case .localFolder:
            localBriefSection
        case .onBranch:
            branchBriefSection
        }
    }

    private var manualTaskSection: some View {
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

    private var localBriefSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            formSection("Folder on daemon host") {
                HStack(spacing: 8) {
                    TextField("/path/to/brief", text: $briefFolderPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                        .onChange(of: briefFolderPath) { _, _ in clearBriefPreview() }
                    Button("Pick...") { pickBriefFolder() }
                }
            }
            if !briefFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(isPreviewingBrief ? "Parsing..." : "Preview Brief") {
                    Task { await runBriefPreview() }
                }
                .disabled(isPreviewingBrief || isSubmitting)
            }
            if let briefPreview {
                briefPreviewSection(briefPreview)
            }
        }
    }

    private var branchBriefSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            formSection("Spec source") {
                TextField("source branch (for specs)", text: $sourceBranch)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                    .onChange(of: sourceBranch) { _, _ in clearBriefPreview() }
                TextField("specs/my-feature", text: $briefBranchPath)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                    .onChange(of: briefBranchPath) { _, _ in clearBriefPreview() }
            }
            if !sourceBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !briefBranchPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                Button(isPreviewingBrief ? "Parsing..." : "Preview Brief") {
                    Task { await runBriefPreview() }
                }
                .disabled(isPreviewingBrief || isSubmitting || selectedProfile.isEmpty)
            } else {
                Text("Set source branch and a path to preview.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            if let briefPreview {
                briefPreviewSection(briefPreview)
            }
        }
    }

    private func briefPreviewSection(_ brief: ParsedBriefResponse) -> some View {
        let scenarioCount = brief.contract?.scenarios.count ?? 0
        let factCount = brief.contract?.requiredFacts.count ?? 0
        let reviewCount = brief.contract?.humanReview.count ?? 0
        let sidecarCount = brief.requireSidecars?.count ?? 0
        let specFileCount = brief.specFiles?.count ?? 0

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(brief.title)
                    .font(.system(.callout).weight(.semibold))
                    .lineLimit(2)
                Spacer()
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            HStack(spacing: 8) {
                previewChip("\(scenarioCount) scenarios", color: .blue)
                previewChip("\(factCount) facts", color: .green)
                previewChip("\(reviewCount) review", color: .purple)
                if sidecarCount > 0 {
                    previewChip("\(sidecarCount) sidecars", color: .orange)
                }
            }
            Text(brief.task)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if taskSource == .onBranch || specFileCount > 0 {
                Toggle(isOn: $includeSpecFiles) {
                    HStack(spacing: 6) {
                        Text("Include spec source in worktree")
                            .font(.caption)
                        if specFileCount > 0 {
                            Text("\(specFileCount)")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                }
                .toggleStyle(.switch)
                .controlSize(.small)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func previewChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func pickBriefFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Select"
        if panel.runModal() == .OK, let url = panel.url {
            briefFolderPath = url.path
            Task { await runBriefPreview() }
        }
    }

    private func clearBriefPreview() {
        briefPreview = nil
        includeSpecFiles = false
        errorMessage = nil
    }

    private func runBriefPreview() async {
        errorMessage = nil
        isPreviewingBrief = true
        defer { isPreviewingBrief = false }

        let response: ParsedBriefResponse? = await {
            switch taskSource {
            case .manual:
                return nil
            case .localFolder:
                let path = briefFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !path.isEmpty else { return nil }
                return await actions.previewBriefFolder(path)
            case .onBranch:
                let branch = sourceBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                let path = briefBranchPath.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !selectedProfile.isEmpty, !branch.isEmpty, !path.isEmpty else { return nil }
                return await actions.previewBriefOnBranch(selectedProfile, branch, path)
            }
        }()

        guard let response else {
            errorMessage = actions.lastPreviewError() ?? "Could not parse that brief."
            briefPreview = nil
            return
        }
        briefPreview = response
        includeSpecFiles = false
        task = response.task
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let model = modelText.trimmingCharacters(in: .whitespacesAndNewlines)
        let pim = pimGroups.filter { !$0.groupId.isEmpty }
        let pod = PodConfigRequest(
            agentMode: agentMode,
            output: outputTarget,
            validate: validate,
            promotable: isInteractive
        )
        let refs = resolvedReferenceRepos()
        let trimmedPrefix = branchPrefix.trimmingCharacters(in: .whitespaces)
        let trimmedBaseBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSourceBranch = sourceBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceBrief = taskSource == .manual ? nil : briefPreview
        let requestTask = sourceBrief?.task ?? task
        let metadata = sourceBrief.map {
            BriefPodMetadata(
                contract: $0.contract,
                briefTitle: $0.title,
                touches: $0.touches,
                doesNotTouch: $0.doesNotTouch,
                startBranch: taskSource == .onBranch && includeSpecFiles && !trimmedSourceBranch.isEmpty
                    ? trimmedSourceBranch
                    : nil,
                specFiles: includeSpecFiles ? $0.specFiles : nil
            )
        }

        let id = await actions.createPod(
            selectedProfile,
            requestTask,
            model.isEmpty ? nil : model,
            pod,
            trimmedBaseBranch.isEmpty ? nil : trimmedBaseBranch,
            trimmedPrefix.isEmpty ? nil : trimmedPrefix,
            pim.isEmpty ? nil : pim,
            sourceBrief?.requireSidecars,
            refs.isEmpty ? nil : refs,
            metadata
        )
        if id != nil {
            isPresented = false
        } else {
            errorMessage = actions.lastCreatePodError() ?? "Pod creation failed."
        }
    }

    /// Reference Repos picker — same UI used for both interactive (inside its
    /// own collapsed DisclosureGroup) and agent-mode (inside Advanced).
    /// `showHeader` controls the inner title; suppress it when the caller's
    /// DisclosureGroup label already says "Reference Repos".
    @ViewBuilder
    private func referenceReposSection(showHeader: Bool = true) -> some View {
        // Reference repos — read-only mounts at /repos/<name>/.
        if showHeader {
            HStack {
                Text("Reference Repos")
                    .font(.system(.caption).weight(.semibold))
                    .foregroundStyle(.secondary)
                HelpBadge(text: "Read-only repos cloned into /repos/<name>/ alongside the primary worktree. Use for cross-repo audits, comparing implementations, or letting the agent reference docs/pipeline definitions while it works.")
                Spacer()
            }
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
