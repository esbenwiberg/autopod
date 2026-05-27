import AppKit
import AutopodClient
import SwiftUI

/// Sheet for launching a pod series from a folder of contract-backed briefs.
/// Flow: pick folder → daemon parses contracts and returns the DAG → user
/// confirms profile / PR mode → submit.
public struct CreateSeriesSheet: View {
    @Binding public var isPresented: Bool
    public let actions: PodActions
    public let profileNames: [String]
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
        initialBaseBranch: String? = nil,
        initialTargetBranch: String? = nil,
        initialProfile: String? = nil,
        initialSyncPodId: String? = nil,
        onSeriesCreated: ((String) -> Void)? = nil
    ) {
        self._isPresented = isPresented
        self.actions = actions
        self.profileNames = profileNames
        self.initialBaseBranch = initialBaseBranch
        self.initialTargetBranch = initialTargetBranch
        self.initialProfile = initialProfile
        self.initialSyncPodId = initialSyncPodId
        self.onSeriesCreated = onSeriesCreated
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
    @State private var selectedProfile: String = ""
    @State private var sourceBranch: String = ""
    @State private var baseBranch: String = ""
    @State private var prMode: String = "single"
    @State private var autoApprove: Bool = false
    @State private var disableAskHuman: Bool = false
    @State private var isInitialSyncing = false
    @State private var initialSyncWarning: String?
    @State private var initialSyncAttemptedPodId: String?
    @State private var isPreviewing = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public var body: some View {
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
                    unattendedSection

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
            if selectedProfile.isEmpty {
                selectedProfile = initialProfile
                    ?? profileNames.first
                    ?? ""
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
            || selectedProfile.isEmpty
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
            Text("Reads contract-backed briefs from the source branch below. PRs target the branch in Target branch above.")
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

            if !sourceBranch.isEmpty && !branchPath.isEmpty && !selectedProfile.isEmpty {
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
        guard !isInitialSyncing else { return }
        errorMessage = nil
        isPreviewing = true
        defer { isPreviewing = false }
        let response: SeriesPreviewResponse? = await {
            switch briefSource {
            case .localFolder:
                return await actions.previewSeriesFolder(folderPath)
            case .onBranch:
                return await actions.previewSeriesOnBranch(selectedProfile, sourceBranch, branchPath)
            }
        }()
        guard let response else {
            let fallback = briefSource == .localFolder
                ? "Could not parse contract-backed briefs from that folder."
                : "Could not parse contract-backed briefs from \(branchPath) on \(sourceBranch). Check the branch has the new layout: one folder per pod, each with brief.md and contract.yaml."
            errorMessage = actions.lastPreviewError() ?? fallback
            preview = nil
            return
        }
        preview = response
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

    private var profilePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Profile")
                .font(.subheadline.weight(.semibold))
            Picker("", selection: $selectedProfile) {
                ForEach(profileNames, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
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

    private var unattendedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Unattended run")
                .font(.subheadline.weight(.semibold))
            Toggle(isOn: $autoApprove) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Auto-approve on validate")
                        .font(.body)
                    Text("Skip the human approval gate — pods merge automatically once validation passes.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(isSubmitting)
            Toggle(isOn: $disableAskHuman) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Replace ask_human with AI")
                        .font(.body)
                    Text("Agent questions are answered by the reviewer model instead of blocking for a human.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(isSubmitting)
        }
    }

    private var baseBranchField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(briefSource == .onBranch ? "Target branch (optional)" : "Base branch (optional)")
                .font(.subheadline.weight(.semibold))
            TextField("main", text: $baseBranch)
                .textFieldStyle(.roundedBorder)
            if briefSource == .onBranch {
                Text("The implementation PR targets this branch. Leave empty to use the profile default.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Submit

    private func submit() async {
        guard let preview else { return }
        errorMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }

        let request = CreateSeriesRequest(
            seriesName: seriesName,
            briefs: preview.briefs,
            profile: selectedProfile,
            startBranch: briefSource == .onBranch && !sourceBranch.isEmpty ? sourceBranch : nil,
            baseBranch: baseBranch.isEmpty ? nil : baseBranch,
            specFiles: preview.specFiles,
            prMode: prMode,
            autoApprove: autoApprove ? true : nil,
            disableAskHuman: disableAskHuman ? true : nil,
            seriesDescription: preview.seriesDescription,
            seriesDesign: preview.seriesDesign
        )
        if let id = await actions.createSeries(request) {
            onSeriesCreated?(id)
            isPresented = false
        } else {
            errorMessage = "Series creation failed — check the daemon log."
        }
    }
}
