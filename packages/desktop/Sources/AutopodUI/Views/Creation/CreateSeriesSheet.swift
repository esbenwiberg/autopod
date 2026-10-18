import AppKit
import AutopodClient
import SwiftUI

/// Sheet for launching a pod series from a folder of contract-backed briefs.
/// Flow: pick folder → daemon parses contracts and returns the DAG → user
/// confirms profile / PR mode → submit.
public struct CreateSeriesSheet: View {
    @Environment(\.desktopRedesign) private var redesign
    @State private var stage: LaunchComposerStage = .compose
    @State private var advanced = ""
    @State private var jsonDirty = false
    @State private var dirty = false
    @State private var confirmClose = false
    @State private var confirmDifferent = false
    @State private var review: SeriesLaunchReview?
    @State private var isResolving = false

    @Binding public var isPresented: Bool
    public let actions: PodActions
    public let profileNames: [String]
    public var configurationActions: LaunchConfigurationActions?
    /// Pre-fill the base branch (e.g. when launching a series from an
    /// interactive pod's branch so the chain stacks on the user's work).
    public let initialBaseBranch: String?
    /// Pre-fill the target branch for PRs when the source branch is separate.
    public let initialTargetBranch: String?
    /// Pre-select a profile (e.g. the initiating pod's profile).
    public let initialProfile: String?
    /// Workspace pod to sync after the sheet appears. Used when launching from
    /// a still-running interactive pod so branch-path previews can read the
    /// latest briefs without blocking sheet presentation.
    public let initialSyncPodId: String?
    public var onSeriesCreated: ((String) -> Void)?

    public init(
        isPresented: Binding<Bool>,
        actions: PodActions,
        profileNames: [String],
        configurationActions: LaunchConfigurationActions? = nil,
        initialBaseBranch: String? = nil,
        initialTargetBranch: String? = nil,
        initialProfile: String? = nil,
        initialSyncPodId: String? = nil,
        onSeriesCreated: ((String) -> Void)? = nil
    ) {
        self._isPresented = isPresented
        self.actions = actions
        self.profileNames = profileNames
        self.configurationActions = configurationActions
        self.initialBaseBranch = initialBaseBranch
        self.initialTargetBranch = initialTargetBranch
        self.initialProfile = initialProfile
        self.initialSyncPodId = initialSyncPodId
        self.onSeriesCreated = onSeriesCreated
    }

    internal init(isPresented: Binding<Bool>, actions: PodActions, configurationActions: LaunchConfigurationActions,
        parsed: SeriesPreviewResponse, selection: [String: ConfigurationJSON], stage: LaunchComposerStage = .compose,
        pending: CreateSeriesRequest? = nil) {
        self.init(isPresented: isPresented, actions: actions, profileNames: [], configurationActions: configurationActions)
        self._preview = State(initialValue: parsed); self._launchSelection = State(initialValue: selection)
        self._seriesName = State(initialValue: parsed.seriesName); self._folderPath = State(initialValue: "/workspace/specs/recovery")
        self._stage = State(initialValue: stage); self._pendingRequest = State(initialValue: pending)
    }
    enum BriefSource: String, CaseIterable, Identifiable {
        case localFolder
        case onBranch
        var id: String { rawValue }
        var label: String {
            switch self {
            case .localFolder: "Local folder"
            case .onBranch:    "Path on branch"
            }
        }
    }

    @State private var briefSource: BriefSource = .localFolder
    @State private var folderPath: String = ""
    @State private var branchPath: String = ""    // relative path on the branch
    @State private var seriesName: String = ""
    @State private var preview: SeriesPreviewResponse?
    @State private var launchSelection: [String: ConfigurationJSON] = [:]
    @State private var pendingRequest: CreateSeriesRequest?
    @State private var sourceBranch: String = ""
    @State private var baseBranch: String = ""
    @State private var prMode: String = "single"
    @State private var includeSpecFiles: Bool = false
    @State private var isInitialSyncing = false
    @State private var initialSyncWarning: String?
    @State private var initialSyncAttemptedPodId: String?
    @State private var isPreviewing = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public var body: some View {
        Group { if redesign { composer } else { legacyBody } }
    }
    private var composer: some View {
        LaunchComposerLayout(series: true, stage: $stage, locked: pendingRequest != nil, busy: composerBusy,
            ready: reviewMatches, close: closeComposer) {
            if let actions = configurationActions {
                if let loadError = actions.loadError {
                    Text(loadError).foregroundStyle(.red)
                    Button("Reload configuration") { Task { await actions.reload() } }.disabled(composerBusy)
                }
                if let pendingRequest {
                    LaunchRetainedRequest(id: pendingRequest.requestId, payload: LaunchComposerJSON.value(pendingRequest), series: true)
                } else {
                    Group {
                        switch stage {
                        case .compose: seriesComposer
                        case .configure:
                            if let typed = try? typedSelection() {
                                LaunchConfigurationEditor(request: Binding(get: { (try? typedSelection()) ?? typed }, set: {
                                    launchSelection = LaunchComposerJSON.value($0, selectionOnly: true).object ?? [:]
                                }), actions: actions, jsonDirty: $jsonDirty, selectionOnly: true, advanced: $advanced)
                            } else {
                                Text("The selection contains fields this desktop cannot preserve. Use the saved request flow or correct the configuration before continuing.").foregroundStyle(.red)
                            }
                        case .review:
                            if let review, reviewMatches {
                                LaunchResolvedReview(preview: review.configuration, series: true)
                                ForEach(Array(review.briefPreviews.enumerated()), id: \.offset) { index, result in
                                    DisclosureGroup(preview?.briefs[index].title ?? "Pod \(index + 1)") {
                                        Text(ConfigurationJSON.object(result.fields).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                    }
                                }
                                if let preview { previewSection(preview) }
                                Text("PR mode: \(prMode) · \(briefSource == .onBranch ? "source: " + sourceBranch : folderPath)")
                                Text("PR target / base: \(baseBranch.isEmpty ? "repository default" : baseBranch)")
                                Text(includeSpecFiles ? "Spec source included in worktree; parsed source retained as context." : "Spec source retained as context only.").font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text("Inspect the plan before creation.").font(.title2.weight(.semibold))
                                Text("Read the briefs, choose the configuration and preview the launch. Each brief’s required sidecars are checked.").foregroundStyle(.secondary)
                            }
                        }
                    }.disabled(composerBusy)
                }
            } else {
                Text("Connect to a daemon with composable configuration to create a series.").foregroundStyle(.secondary)
            }
        } summary: {
            if let actions = configurationActions {
                LaunchComposerSummary(context: .init(request: summaryRequest, actions: actions, preview: reviewMatches ? review?.configuration : nil),
                    status: pendingRequest != nil ? "Result unconfirmed" : reviewMatches ? "Preview ready" : "Needs preview",
                    seriesPlan: "\(pendingRequest?.briefs.count ?? preview?.briefs.count ?? 0) pods · \((pendingRequest?.prMode ?? prMode) == "single" ? "one PR, serial ordering" : (pendingRequest?.prMode ?? prMode) == "stacked" ? "PR per pod" : "branches only")")
            }
        } footer: {
            seriesFooter
        }
        .onAppear { initializeSelection() }
        .task(id: initialSyncPodId) { await runInitialBranchSyncIfNeeded() }
        .onChange(of: sourceIdentity) { _, _ in preview = nil; includeSpecFiles = false; review = nil; dirty = true }
        .onChange(of: currentFingerprint) { _, _ in review = nil; dirty = true }
        .onChange(of: configurationActions?.documents) { _, _ in review = nil }
        .onChange(of: configurationActions?.capabilities) { _, _ in review = nil }
        .onChange(of: jsonDirty) { _, value in if value { review = nil; dirty = true } }
        .interactiveDismissDisabled(composerBusy || dirty || jsonDirty || pendingRequest != nil)
        .confirmationDialog("Leave this series draft?", isPresented: $confirmClose) {
            Button("Leave draft", role: .destructive) { isPresented = false }
            Button("Keep working", role: .cancel) {}
        } message: { Text(pendingRequest == nil ? "Unsaved choices will be discarded." : "The result is unconfirmed. Its saved request remains available for retry.") }
        .confirmationDialog("Start a different series launch?", isPresented: $confirmDifferent) {
            Button("Edit a different launch", role: .destructive) { pendingRequest = nil; review = nil; stage = .compose }
            Button("Keep saved request", role: .cancel) {}
        } message: { Text("The earlier request may already have created a series. Different work uses a new identity.") }
    }
    private var composerBusy: Bool { isSubmitting || isPreviewing || isInitialSyncing || isResolving }
    private func closeComposer() { if dirty || jsonDirty || pendingRequest != nil { confirmClose = true } else { isPresented = false } }
    private var sourceIdentity: ConfigurationJSON { .object([
        "repository": launchSelection["repositoryId"] ?? .null, "source": .string(briefSource.rawValue),
        "folder": .string(folderPath), "branch": .string(sourceBranch), "path": .string(branchPath)
    ]) }
    private var currentFingerprint: ConfigurationJSON? { makeRequest(id: "review").map(SeriesLaunchReview.fingerprint) }
    private var reviewMatches: Bool { !jsonDirty && makeRequest(id: "review").map { review?.matches($0) == true } == true }
    private func typedSelection() throws -> ComposableLaunchRequest {
        try LaunchComposerJSON.decode(ConfigurationJSON.object(launchSelection).formatted(), selectionOnly: true,
            task: seriesName.isEmpty ? "Series configuration" : seriesName)
    }
    private var summaryRequest: ComposableLaunchRequest {
        if let pendingRequest {
            return (try? LaunchComposerJSON.decode(ConfigurationJSON.object(pendingRequest.launch).formatted(), selectionOnly: true, task: pendingRequest.seriesName)) ?? ComposableLaunchRequest()
        }
        return (try? typedSelection()) ?? ComposableLaunchRequest()
    }
    private func changeSelection(_ edit: (inout ComposableLaunchRequest) -> Void) {
        guard var request = try? typedSelection() else { return }
        edit(&request); launchSelection = LaunchComposerJSON.value(request, selectionOnly: true).object ?? [:]
    }
    private var seriesComposer: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Build the plan from its briefs.").font(.title2.weight(.semibold))
            Text("Choose where the contract-backed source lives. Source and target branches have separate jobs.").font(.callout).foregroundStyle(.secondary)
            if let actions = configurationActions {
                Picker("Repository", selection: Binding(get: { launchSelection["repositoryId"]?.string ?? "" }, set: { id in changeSelection { $0.select(.repository, id: id.isEmpty ? nil : id) } })) {
                    Text("Select repository").tag("")
                    ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
                }.accessibilityIdentifier("series-repository")
                if let repo = actions.list(.repository).first(where: { $0.id == launchSelection["repositoryId"]?.string }) {
                    Picker("Project setup", selection: Binding(get: { launchSelection["repositorySetupId"]?.string ?? "" }, set: { id in changeSelection { $0.repositorySetupId = id.isEmpty ? nil : id } })) {
                        Text("Repository default").tag("")
                        ForEach(Array((repo.payload["setups"]?.array ?? []).enumerated()), id: \.offset) { _, setup in Text(setup["name"]?.string ?? "Setup").tag(setup["id"]?.string ?? "") }
                    }
                }
                Picker("Profile", selection: Binding(get: { launchSelection["profileId"]?.string ?? "" }, set: { id in changeSelection { $0.select(.profile, id: id.isEmpty ? nil : id) } })) {
                    Text("Repository usual profile").tag("")
                    ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
                }
            }
            sourcePicker
            initialSyncStatus
            if initialSyncWarning != nil { Button("Retry workspace sync") { initialSyncAttemptedPodId = nil; Task { await runInitialBranchSyncIfNeeded() } } }
            briefSourceFields
            if let preview {
                previewSection(preview)
                ForEach(Array(preview.briefs.enumerated()), id: \.offset) { _, brief in
                    DisclosureGroup(brief.title) {
                        Text(brief.task).font(.callout).textSelection(.enabled)
                        Text("Depends on: \(brief.dependsOn.isEmpty ? "nothing" : brief.dependsOn.joined(separator: ", "))").font(.caption)
                        Text("\(brief.contract?.requiredFacts.count ?? 0) facts · sidecars: \((brief.requireSidecars ?? []).joined(separator: ", "))").font(.caption)
                        DisclosureGroup("Complete brief & contract") { Text(LaunchComposerJSON.value(brief).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    }.padding(14).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 6))
                }
                if let description = preview.seriesDescription { DesktopPanel(title: "Series description") { Text(description).textSelection(.enabled) } }
                if let design = preview.seriesDesign { DisclosureGroup("Series design") { Text(design).textSelection(.enabled) } }
            }
            prModePicker
            Text(prMode == "single" ? "Single-PR mode adds serial ordering. Declared dependencies are retained." : "The plan follows declared contract dependencies.").font(.caption).foregroundStyle(.secondary)
            baseBranchField
            Text("The selected workflow controls approval, merge and agent questions.").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var seriesFooter: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            if jsonDirty { Text("Apply or reload unapplied JSON before previewing or creating the series.").font(.caption).foregroundStyle(.orange) }
            if let actions = configurationActions, actions.capabilities["launchAvailable"]?.bool != true {
                Text(actions.capabilities["launchUnavailableReason"]?.string ?? "Launch is unavailable until daemon configuration and execution checks are complete.").font(.caption).foregroundStyle(.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack { seriesStatus; Spacer(); seriesButtons }
                VStack(alignment: .leading, spacing: 10) { seriesStatus; HStack { Spacer(); seriesButtons } }
            }
        }
    }
    private var seriesStatus: some View {
        HStack {
            if composerBusy { ProgressView().controlSize(.small) }
            Text(pendingRequest != nil ? "Result unconfirmed · exact request saved" : reviewMatches ? "Preview ready" : "Read briefs and preview before creation").font(.caption).foregroundStyle(.secondary)
        }
    }
    @ViewBuilder private var seriesButtons: some View {
        if pendingRequest != nil {
            Button("Start a different launch") { confirmDifferent = true }.disabled(composerBusy)
            Button("Retry saved request") { Task { await submit() } }.buttonStyle(.borderedProminent).disabled(composerBusy).accessibilityIdentifier("series-retry")
        } else {
            Button("Saved requests…") { retrySavedRequest() }.disabled(composerBusy)
            if stage == .compose { Button("Inspect configuration →") { stage = .configure }.disabled(composerBusy) }
            Button(reviewMatches ? "Refresh preview" : "Preview launch") { Task { await resolveSeriesConfiguration() } }
                .disabled(composerBusy || preview == nil || jsonDirty || seriesName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("series-preview")
            Button("Create series") { Task { await submit() } }.buttonStyle(.borderedProminent)
                .disabled(composerBusy || !reviewMatches || submitDisabled).accessibilityIdentifier("series-submit")
        }
    }
    private func initializeSelection() {
        if launchSelection["profileId"] == nil, let initialProfile, configurationActions?.list(.profile).contains(where: { $0.id == initialProfile }) == true { launchSelection["profileId"] = .string(initialProfile) }
        if baseBranch.isEmpty, let target = initialTargetBranch { baseBranch = target }
        if let initial = initialBaseBranch, !initial.isEmpty { briefSource = .onBranch; if sourceBranch.isEmpty { sourceBranch = initial } }
    }
    private func resolveSeriesConfiguration() async {
        guard !composerBusy, !jsonDirty, let candidate = makeRequest(id: "review"), let configurationActions else { return }
        guard !candidate.briefs.isEmpty, candidate.launch["repositoryId"]?.string != nil else { errorMessage = "Read at least one brief and select a repository."; return }
        isResolving = true; errorMessage = nil; review = nil
        let fingerprint = SeriesLaunchReview.fingerprint(candidate), source = sourceIdentity
        defer { isResolving = false }
        do {
            let documents = configurationActions.documents, capabilities = configurationActions.capabilities
            let base = try await configurationActions.resolve(typedSelection())
            guard sourceIdentity == source, currentFingerprint == fingerprint, !jsonDirty else { return }
            guard base.intent == "task", base.fields["workflow"]?["agentMode"]?.string == "auto" else {
                throw LaunchJSONError.invalid("Series require an automatic Task workflow.")
            }
            let baseSidecars = base.fields["requiredSidecarIds"]?.array?.compactMap(\.string) ?? []
            var results: [EffectiveLaunchPreview] = []
            for brief in candidate.briefs {
                var request = try typedSelection()
                request.task = brief.task
                request.requiredSidecarIds = Array(Set(baseSidecars + (brief.requireSidecars ?? []))).sorted()
                let result = try await configurationActions.resolve(request)
                guard sourceIdentity == source, currentFingerprint == fingerprint, !jsonDirty,
                      configurationActions.documents == documents, configurationActions.capabilities == capabilities else { return }
                results.append(result)
            }
            review = .init(payload: fingerprint, configuration: base, briefPreviews: results); stage = .review
        } catch { errorMessage = error.localizedDescription }
    }
    private func makeRequest(id: String) -> CreateSeriesRequest? {
        guard let preview else { return nil }
        return CreateSeriesRequest(requestId: id, seriesName: seriesName, briefs: preview.briefs, launch: launchSelection,
            startBranch: briefSource == .onBranch && includeSpecFiles && !sourceBranch.isEmpty ? sourceBranch : nil,
            baseBranch: baseBranch.isEmpty ? nil : baseBranch, specFiles: includeSpecFiles ? preview.specFiles : nil,
            specContextFiles: preview.specFiles, prMode: prMode, seriesDescription: preview.seriesDescription, seriesDesign: preview.seriesDesign)
    }
    private var legacyBody: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("New Series")
                        .font(.title2.weight(.semibold))

                    sourcePicker
                    profilePicker
                    baseBranchField
                    initialSyncStatus
                    briefSourceFields
                    if let preview {
                        previewSection(preview)
                    }
                    prModePicker
                    Text("The selected workflow controls approval, merge and agent questions.").font(.caption).foregroundStyle(.secondary)

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
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            HStack {
                Button("Retry saved request…") { retrySavedRequest() }.disabled(isSubmitting)
                Spacer()
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button(isSubmitting ? "Creating…" : "Create Series") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitDisabled)
            }
            .padding(20)
        }
        .frame(width: 640, height: 700)
        .onAppear {
            if launchSelection["profileId"] == nil, let initialProfile,
               configurationActions?.list(.profile).contains(where: { $0.id == initialProfile }) == true {
                launchSelection["profileId"] = .string(initialProfile)
            }
            if baseBranch.isEmpty, let target = initialTargetBranch {
                baseBranch = target
            }
            // Launched from an interactive pod: default to "Path on branch"
            // mode — initialBaseBranch is the branch to read specs from.
            if let initial = initialBaseBranch, !initial.isEmpty {
                briefSource = .onBranch
                if sourceBranch.isEmpty { sourceBranch = initial }
            }
        }
        .task(id: initialSyncPodId) {
            await runInitialBranchSyncIfNeeded()
        }
    }

    private var submitDisabled: Bool {
        isSubmitting
            || isInitialSyncing
            || preview == nil
            || launchSelection["repositoryId"]?.string == nil
            || configurationActions?.capabilities["launchAvailable"]?.bool != true
            || seriesName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    // MARK: - Source picker

    private var sourcePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Brief source")
                .font(.subheadline.weight(.semibold))
            Picker("", selection: $briefSource) {
                ForEach(BriefSource.allCases) { src in
                    Text(src.label).tag(src)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(isSubmitting)
            .onChange(of: briefSource) { _, _ in
                preview = nil
                includeSpecFiles = false
                errorMessage = nil
            }
        }
    }

    @ViewBuilder
    private var briefSourceFields: some View {
        switch briefSource {
        case .localFolder:
            localFolderFields
        case .onBranch:
            onBranchFields
        }
    }

    private var localFolderFields: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Folder on daemon host")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                TextField("/path/to/briefs", text: $folderPath)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSubmitting)
                Button("Pick…") { pickFolder() }
                    .disabled(isSubmitting)
            }
            if !folderPath.isEmpty {
                Button(isPreviewing ? "Parsing…" : "Preview series") {
                    Task { await runPreview() }
                }
                .disabled(isInitialSyncing || isPreviewing || isSubmitting)
            }
        }
    }

    private var onBranchFields: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reads contract-backed briefs from this source branch. The separate target branch controls where implementation PRs land.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 3) {
                Text("Source branch").font(.caption2).foregroundStyle(.secondary)
                TextField("docs/spec-my-feature", text: $sourceBranch)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSubmitting)
                    .onChange(of: sourceBranch) { _, _ in preview = nil }
                Text("Path on source branch").font(.caption2).foregroundStyle(.secondary)
                TextField("specs/my-feature/briefs", text: $branchPath)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSubmitting)
                    .onChange(of: branchPath) { _, _ in preview = nil }
            }

            if !sourceBranch.isEmpty && !branchPath.isEmpty && launchSelection["repositoryId"]?.string != nil {
                Button(isPreviewing ? "Parsing…" : "Preview series") {
                    Task { await runPreview() }
                }
                .disabled(isInitialSyncing || isPreviewing || isSubmitting)
            } else if sourceBranch.isEmpty {
                Text("Set source branch to read briefs from.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Select"
        if panel.runModal() == .OK, let url = panel.url {
            folderPath = url.path
            Task { await runPreview() }
        }
    }

    @ViewBuilder
    private var initialSyncStatus: some View {
        if isInitialSyncing {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Syncing workspace branch...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if let warning = initialSyncWarning {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func runInitialBranchSyncIfNeeded() async {
        guard let podId = initialSyncPodId else { return }
        guard initialSyncAttemptedPodId != podId else { return }
        initialSyncAttemptedPodId = podId
        initialSyncWarning = nil
        isInitialSyncing = true
        let response = await actions.syncWorkspaceBranch(podId)
        isInitialSyncing = false
        if response == nil {
            initialSyncWarning = "Could not sync the workspace branch. You can still preview, but branch-path specs may be stale."
        }
    }

    private func runPreview() async {
        guard !isInitialSyncing, !isPreviewing, !isSubmitting else { return }
        errorMessage = nil
        isPreviewing = true
        let source = sourceIdentity
        defer { isPreviewing = false }
        let response: SeriesPreviewResponse? = await {
            switch briefSource {
            case .localFolder:
                return await actions.previewSeriesFolder(folderPath)
            case .onBranch:
                return await actions.previewSeriesOnBranch(launchSelection["repositoryId"]?.string ?? "", sourceBranch, branchPath)
            }
        }()
        guard sourceIdentity == source else { return }
        guard let response else {
            let fallback = briefSource == .localFolder
                ? "Could not parse contract-backed briefs from that folder."
                : "Could not parse contract-backed briefs from \(branchPath) on \(sourceBranch). Check the branch has the new layout: one folder per pod, each with brief.md and contract.yaml."
            errorMessage = actions.lastPreviewError() ?? fallback
            preview = nil
            return
        }
        review = nil
        preview = response
        includeSpecFiles = false
        if seriesName.isEmpty { seriesName = response.seriesName }
    }

    // MARK: - Preview section

    @ViewBuilder
    private func previewSection(_ preview: SeriesPreviewResponse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Preview")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(preview.briefs.count) pods")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            briefDAG(preview.briefs)
                .frame(maxWidth: .infinity)
                .frame(height: 180)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 6))

            TextField("Series name", text: $seriesName)
                .textFieldStyle(.roundedBorder)
            let specFileCount = preview.specFiles?.count ?? 0
            if briefSource == .onBranch || specFileCount > 0 {
                Toggle(isOn: $includeSpecFiles) {
                    HStack(spacing: 6) {
                        Text("Include spec source in worktree")
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
                .disabled(isSubmitting)
            }
        }
    }

    private func briefDAG(_ briefs: [ParsedBriefResponse]) -> some View {
        // Single-mode siblings share the root's branch, and Git allows only one
        // worktree per branch. The daemon chains them at creation time — mirror
        // that here so the preview matches the physical execution order the
        // user is about to trigger instead of the aspirational brief DAG.
        let inputs: [PipelineDAGLayout.Input] = briefs.enumerated().map { idx, brief in
            if prMode == "single", idx > 0 {
                let previous = briefs[idx - 1].title
                var parents = brief.dependsOn
                if !parents.contains(previous) { parents.append(previous) }
                return PipelineDAGLayout.Input(id: brief.title, parentIds: parents)
            }
            return PipelineDAGLayout.Input(id: brief.title, parentIds: brief.dependsOn)
        }
        // Taller nodes so the sidecar chip has somewhere to sit without
        // clipping the title.
        let metrics = PipelineDAGLayout.Metrics(
            nodeWidth: 140, nodeHeight: 56,
            horizontalGap: 40, verticalGap: 16,
            paddingX: 12, paddingY: 12
        )
        let layout = PipelineDAGLayout.layout(inputs, metrics: metrics)
        let positions = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.id, $0.position) })
        // Fast lookup from brief title → sidecar list for the badge render.
        let sidecarsByTitle: [String: [String]] = Dictionary(
            uniqueKeysWithValues: briefs.compactMap { b in
                guard let s = b.requireSidecars, !s.isEmpty else { return nil }
                return (b.title, s)
            }
        )
        let factsByTitle: [String: Int] = Dictionary(
            uniqueKeysWithValues: briefs.map { b in
                (b.title, b.contract?.requiredFacts.count ?? 0)
            }
        )
        let edges = layout.edges.map {
            PipelineEdgeCanvas.EdgeStyle(from: $0.from, to: $0.to, color: .accentColor)
        }
        return ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                PipelineEdgeCanvas(
                    edges: edges,
                    nodePositions: positions,
                    nodeSize: CGSize(width: metrics.nodeWidth, height: metrics.nodeHeight)
                )
                .frame(width: layout.width, height: layout.height)

                ForEach(layout.nodes, id: \.id) { node in
                    briefNode(
                        title: node.id,
                        sidecars: sidecarsByTitle[node.id] ?? [],
                        factCount: factsByTitle[node.id] ?? 0
                    )
                    .frame(width: metrics.nodeWidth, height: metrics.nodeHeight)
                    .position(x: node.position.x, y: node.position.y)
                }
            }
            .frame(width: layout.width, height: layout.height)
        }
    }

    /// A single brief node in the DAG. Shows the title plus, when the brief
    /// requested sidecars, a chip listing them (e.g. "🛠 dagger"). The chip
    /// is orange-tinted — a quiet "privileged container will spawn here"
    /// signal for reviewers before they click Create.
    @ViewBuilder
    private func briefNode(title: String, sidecars: [String], factCount: Int) -> some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.center)
            if factCount > 0 {
                Text("\(factCount) facts")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.green)
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.green.opacity(0.12))
                    .clipShape(Capsule())
            }
            if !sidecars.isEmpty {
                Text("🛠 \(sidecars.joined(separator: ", "))")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.orange.opacity(0.12))
                    .clipShape(Capsule())
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            sidecars.isEmpty
                ? Color.accentColor.opacity(0.12)
                : Color.orange.opacity(0.10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 5)
                .stroke(
                    sidecars.isEmpty
                        ? Color.accentColor.opacity(0.5)
                        : Color.orange.opacity(0.6),
                    lineWidth: 1
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }

    // MARK: - Other fields

    @ViewBuilder
    private var profilePicker: some View {
        if let configurationActions {
            ScheduledLaunchSelectionEditor(actions: configurationActions, selection: $launchSelection,
                task: seriesName.isEmpty ? "Series configuration" : seriesName)
                .onChange(of: launchSelection["repositoryId"]) { _, _ in preview = nil }
        } else {
            Text("Connect to a daemon with composable configuration to create a series.").foregroundStyle(.secondary)
        }
    }

    private var prModePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("PR mode")
                .font(.subheadline.weight(.semibold))
            Picker("", selection: $prMode) {
                Text("Single (one PR)").tag("single")
                Text("Stacked (one PR per pod)").tag("stacked")
                Text("None (branches only)").tag("none")
            }
            .pickerStyle(.segmented)
        }
    }

    private var baseBranchField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(briefSource == .onBranch ? "Target branch (optional)" : "Base branch (optional)")
                .font(.subheadline.weight(.semibold))
            TextField("main", text: $baseBranch)
                .textFieldStyle(.roundedBorder)
            if briefSource == .onBranch {
                Text("The implementation PR targets this branch. Leave empty to use the repository default.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Submit

    private func retrySavedRequest() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autopod/series-launches")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            let request = try JSONDecoder().decode(CreateSeriesRequest.self, from: data)
            let original = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
            let roundtrip = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))
            guard original == roundtrip else { throw LaunchJSONError.invalid("This desktop cannot preserve every field in the saved series. Retry it with the CLI.") }
            pendingRequest = request
            if redesign { stage = .review }
            Task { await sendSeries(request) }
        } catch { errorMessage = error.localizedDescription }
    }

    private func submit() async {
        guard !isSubmitting else { return }
        if let pendingRequest { await sendSeries(pendingRequest); return }
        guard !submitDisabled, !jsonDirty, !redesign || reviewMatches,
              let request = makeRequest(id: UUID().uuidString) else { return }
        pendingRequest = request
        await sendSeries(request)
    }
    private func sendSeries(_ request: CreateSeriesRequest) async {
        guard !isSubmitting else { return }
        isSubmitting = true; errorMessage = nil
        defer { isSubmitting = false }
        if let id = await actions.createSeries(request) {
            onSeriesCreated?(id); isPresented = false
        } else {
            errorMessage = "\(actions.lastCreatePodError() ?? "Series creation was not confirmed.") Retry the saved request without editing. Saved at ~/.autopod/series-launches/\(request.requestId).json"
        }
    }
}
