import AppKit
import AutopodClient
import SwiftUI

/// Sheet for launching a pod series from a folder of markdown briefs.
/// Flow: pick folder → daemon parses briefs and returns the DAG → user
/// confirms profile / PR mode → submit.
public struct CreateSeriesSheet: View {
    @Binding public var isPresented: Bool
    public let actions: PodActions
    public let profileNames: [String]
    /// Pre-fill the base branch (e.g. when launching a series from an
    /// interactive pod's branch so the chain stacks on the user's work).
    public let initialBaseBranch: String?
    /// Pre-select a profile (e.g. the initiating pod's profile).
    public let initialProfile: String?
    public var onSeriesCreated: ((String) -> Void)?

    public init(
        isPresented: Binding<Bool>,
        actions: PodActions,
        profileNames: [String],
        initialBaseBranch: String? = nil,
        initialProfile: String? = nil,
        onSeriesCreated: ((String) -> Void)? = nil
    ) {
        self._isPresented = isPresented
        self.actions = actions
        self.profileNames = profileNames
        self.initialBaseBranch = initialBaseBranch
        self.initialProfile = initialProfile
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
    @State private var baseBranch: String = ""
    @State private var prMode: String = "single"
    @State private var isPreviewing = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Series")
                .font(.title2.weight(.semibold))

            sourcePicker
            profilePicker
            baseBranchField
            briefSourceFields
            if let preview {
                previewSection(preview)
            }
            prModePicker

            if let err = errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.red.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            Spacer(minLength: 0)

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
        }
        .padding(20)
        .frame(width: 640, height: 620)
        .onAppear {
            if selectedProfile.isEmpty {
                selectedProfile = initialProfile
                    ?? profileNames.first
                    ?? ""
            }
            if baseBranch.isEmpty, let initial = initialBaseBranch {
                baseBranch = initial
            }
            // Launched from an interactive pod: default to "Path on branch"
            // mode — baseBranch is already the branch to read from + stack on.
            if let initial = initialBaseBranch, !initial.isEmpty {
                briefSource = .onBranch
                if baseBranch.isEmpty { baseBranch = initial }
            }
        }
    }

    private var submitDisabled: Bool {
        isSubmitting
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
                Button(isPreviewing ? "Parsing…" : "Parse briefs") {
                    Task { await runPreview() }
                }
                .disabled(isPreviewing || isSubmitting)
            }
        }
    }

    private var onBranchFields: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reads briefs directly from the Base branch above. Useful when `/prep` wrote briefs to `specs/<feature>/briefs/` on a branch, or when stacking on an interactive pod's work.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 3) {
                Text("Path on base branch").font(.caption2).foregroundStyle(.secondary)
                TextField("specs/my-feature/briefs", text: $branchPath)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSubmitting)
            }

            if !baseBranch.isEmpty && !branchPath.isEmpty && !selectedProfile.isEmpty {
                Button(isPreviewing ? "Parsing…" : "Parse briefs") {
                    Task { await runPreview() }
                }
                .disabled(isPreviewing || isSubmitting)
            } else if baseBranch.isEmpty {
                Text("Set Base branch above to read briefs from.")
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

    private func runPreview() async {
        errorMessage = nil
        isPreviewing = true
        defer { isPreviewing = false }
        let response: SeriesPreviewResponse? = await {
            switch briefSource {
            case .localFolder:
                return await actions.previewSeriesFolder(folderPath)
            case .onBranch:
                return await actions.previewSeriesOnBranch(selectedProfile, baseBranch, branchPath)
            }
        }()
        guard let response else {
            errorMessage = briefSource == .localFolder
                ? "Could not parse briefs from that folder."
                : "Could not parse briefs from \(branchPath) on \(baseBranch). Check the profile has access and the path exists on the branch."
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
                .frame(height: 180)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 6))

            TextField("Series name", text: $seriesName)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func briefDAG(_ briefs: [ParsedBriefResponse]) -> some View {
        let inputs = briefs.map {
            PipelineDAGLayout.Input(id: $0.title, parentIds: $0.dependsOn)
        }
        let metrics = PipelineDAGLayout.Metrics(
            nodeWidth: 140, nodeHeight: 44,
            horizontalGap: 40, verticalGap: 14,
            paddingX: 12, paddingY: 12
        )
        let layout = PipelineDAGLayout.layout(inputs, metrics: metrics)
        let positions = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.id, $0.position) })
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
                    Text(node.id)
                        .font(.caption)
                        .lineLimit(2)
                        .padding(6)
                        .frame(width: metrics.nodeWidth, height: metrics.nodeHeight)
                        .background(Color.accentColor.opacity(0.12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 5)
                                .stroke(Color.accentColor.opacity(0.5), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .position(x: node.position.x, y: node.position.y)
                }
            }
            .frame(width: layout.width, height: layout.height)
        }
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

    private var baseBranchField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(briefSource == .onBranch ? "Base branch" : "Base branch (optional)")
                .font(.subheadline.weight(.semibold))
            TextField("main", text: $baseBranch)
                .textFieldStyle(.roundedBorder)
                .onChange(of: baseBranch) { _, _ in
                    if briefSource == .onBranch { preview = nil }
                }
            if briefSource == .onBranch {
                Text("The series stacks on this branch, and briefs are read from the path below on this branch.")
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
            baseBranch: baseBranch.isEmpty ? nil : baseBranch,
            prMode: prMode
        )
        if let id = await actions.createSeries(request) {
            onSeriesCreated?(id)
            isPresented = false
        } else {
            errorMessage = "Series creation failed — check the daemon log."
        }
    }
}
