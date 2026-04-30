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
    case sandbox
    case actions
    case issueWatcher
    case validation
    case credentials
    case injections
    case memory
    case deployment

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
        case .sandbox:    "Sandbox & Test Pipeline"
        case .actions:    "Actions"
        case .issueWatcher: "Issue Watcher"
        case .validation: "Validation"
        case .credentials: "Credentials"
        case .injections: "Injections"
        case .memory:     "Memory"
        case .deployment: "Deployment"
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
        case .sandbox:    "lock.shield"
        case .actions:    "bolt.shield"
        case .issueWatcher: "eye"
        case .validation: "globe"
        case .credentials: "key"
        case .injections: "syringe"
        case .memory:     "brain"
        case .deployment: "paperplane.fill"
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
        case .sandbox:
            "Trust gate for privileged sidecars (e.g. Dagger engine) and configuration for the ADO test pipeline the agent can trigger for integration validation."
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
        case .deployment:
            "Configures the run_deploy_script action: env vars (with $DAEMON: refs resolved at exec time, never written into the container's env), an enable gate, and an optional script-path glob allowlist. Scripts are hashed at human approval and re-verified at execution to prevent post-approval swaps."
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
        case .sandbox:
            ["sandbox", "trusted source", "trust", "sidecar", "dagger", "test pipeline", "test repo", "ado pipeline", "pipeline trigger", "rate limit"]
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
        case .deployment:
            ["deploy", "deployment", "deploy script", "run_deploy_script", "env vars", "secrets", "$DAEMON", "allowed scripts", "hash pin"]
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
    public var onSave: ((Profile) async throws -> Void)?
    public var onAuthenticate: ProfileAuthHandler?
    public var memoryEntries: [MemoryEntry] = []
    public var onApproveMemory: (String) -> Void = { _ in }
    public var onRejectMemory: (String) -> Void = { _ in }
    public var onDeleteMemory: (String) -> Void = { _ in }
    public var onEditMemory: ((String, String) -> Void)?
    /// When editing an existing derived profile, this loads the raw + parent
    /// + sourceMap so we can render Inherited/Overridden chips. Optional —
    /// when nil, the editor renders without chips (legacy behavior).
    public var onLoadEditor: ((String) async throws -> ProfileEditorResponse)?
    /// Inheritance-aware save. Called with:
    ///  - `currentInherited`: fields the UI currently marks as inherited.
    ///    The store should strip these from the patch entirely unless they
    ///    are in `initialInherited` — see note below.
    ///  - `initialInherited`: fields that were inherited when the editor
    ///    first loaded. The diff `currentInherited - initialInherited` is
    ///    the set of fields the user toggled this session and which must
    ///    be sent as `null` on the wire to reset the override.
    ///  - `mergeStrategy`: merge-vs-replace per merge-special field.
    /// When nil, the editor falls back to `onSave(profile)`.
    public var onSaveWithInheritance: (
        (
            Profile,
            _ currentInherited: Set<String>,
            _ initialInherited: Set<String>,
            _ mergeStrategy: [String: MergeMode]
        ) async throws -> Void
    )?
    /// Inheritance-aware create. Called with the draft profile, the set of
    /// fields currently marked inherited (stripped before POST), and the
    /// chosen merge strategy per merge-special field. When nil, the editor
    /// falls back to `onSave(profile)` for new derived profiles.
    public var onCreateWithInheritance: (
        (
            Profile,
            _ currentInherited: Set<String>,
            _ mergeStrategy: [String: MergeMode]
        ) async throws -> Void
    )?
    /// Delete the profile by name. When nil, the Delete button is hidden.
    public var onDelete: ((String) async throws -> Void)?

    public init(profile: Profile, isNew: Bool,
                actionCatalog: [ActionCatalogItem] = [],
                onSave: ((Profile) async throws -> Void)? = nil,
                onAuthenticate: ProfileAuthHandler? = nil,
                memoryEntries: [MemoryEntry] = [],
                onApproveMemory: @escaping (String) -> Void = { _ in },
                onRejectMemory: @escaping (String) -> Void = { _ in },
                onDeleteMemory: @escaping (String) -> Void = { _ in },
                onEditMemory: ((String, String) -> Void)? = nil,
                onLoadEditor: ((String) async throws -> ProfileEditorResponse)? = nil,
                onSaveWithInheritance: (
                    (Profile, Set<String>, Set<String>, [String: MergeMode]) async throws -> Void
                )? = nil,
                onCreateWithInheritance: (
                    (Profile, Set<String>, [String: MergeMode]) async throws -> Void
                )? = nil,
                onDelete: ((String) async throws -> Void)? = nil) {
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
        self.onLoadEditor = onLoadEditor
        self.onSaveWithInheritance = onSaveWithInheritance
        self.onCreateWithInheritance = onCreateWithInheritance
        self.onDelete = onDelete
    }

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSection: ProfileSection = .general
    @State private var authStatus: AuthStatus?
    @State private var searchText: String = ""
    @State private var searchLastSection: ProfileSection = .general
    @State private var isSaving: Bool = false
    @State private var saveError: String?
    @State private var isDeleting: Bool = false
    @State private var showDeleteConfirmation: Bool = false
    @State private var editorPayload: ProfileEditorResponse?
    /// Load state for the inheritance payload. Drives the overrides view's
    /// loading / error UI. We route derived profiles to the overrides view
    /// *by intent* (`extendsProfile != nil`), not by whether the payload has
    /// arrived — a slow or failing fetch must never silently fall back to
    /// the legacy editor.
    @State private var editorLoadState: EditorLoadState = .idle
    /// Current "is this field inherited?" state as shown in the UI.
    /// Seeded from the server's sourceMap on load; flipped when the user
    /// taps a chip. Used to drive the disabled/enabled input state.
    @State private var inheritedFields: Set<String> = []
    /// The set as it was when the editor first loaded. Used at save time
    /// to compute only the user's actual changes — we don't want to re-send
    /// `null` for fields that were *already* inherited on the server.
    @State private var initialInheritedFields: Set<String> = []
    /// Working copy of profile.mergeStrategy.
    @State private var mergeStrategyDraft: [String: MergeMode] = [:]
    /// The merge-strategy state as loaded, for the same delta reason.
    @State private var initialMergeStrategy: [String: MergeMode] = [:]

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

    private enum EditorLoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if showOverridesView {
                overridesView
            } else {
                HStack(spacing: 0) {
                    sectionSidebar
                    Divider()
                    sectionContent
                }
            }
            Divider()
            actionBar
        }
        .frame(width: 880, height: 720)
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await loadEditorPayloadIfNeeded() }
    }

    /// Show the overrides editor whenever the profile is a derived profile —
    /// existing or new. Routing is intent-based: the presence of
    /// `extendsProfile` is the contract. The actual payload loads
    /// asynchronously; while it loads (or if it fails) the overrides view
    /// renders its own loading / error UI. We never silently fall back to
    /// the legacy editor for a derived profile, since that UX looks like
    /// "the new UI is broken".
    private var showOverridesView: Bool {
        profile.extendsProfile != nil
    }

    // MARK: - Inheritance support

    /// Fetch the editor payload (raw + resolved + parent + sourceMap) so the
    /// editor can render Inherited/Overridden chips.
    ///
    /// For existing derived profiles we fetch this profile's own editor
    /// payload. For new derived profiles there's no server-side profile yet,
    /// so we fetch the *parent's* editor payload and synthesize a local
    /// payload in which every overridable field is marked inherited —
    /// giving the user the familiar "Inheriting everything; add an override"
    /// empty state to start from.
    private func loadEditorPayloadIfNeeded() async {
        guard profile.extendsProfile != nil else { return }
        guard let onLoadEditor else {
            await MainActor.run {
                self.editorLoadState = .failed("Editor client not wired up. Reconnect to the daemon and try again.")
            }
            return
        }
        await MainActor.run { self.editorLoadState = .loading }
        do {
            if isNew {
                guard let parentName = profile.extendsProfile else { return }
                let parentPayload = try await onLoadEditor(parentName)
                let allKeys = ProfileOverrideCatalog.all.map(\.key)
                // The parent's fully-resolved view is what a not-yet-overridden
                // child inherits. We treat it as both `parent` and `resolved`
                // on the synthesized payload — the derived profile has no
                // own values yet, so it behaves exactly like the parent.
                var emptyRaw = ProfileResponse()
                emptyRaw.name = ""
                emptyRaw.extends = parentName
                let sourceMap = Dictionary(uniqueKeysWithValues: allKeys.map { ($0, FieldSource.inherited) })
                // `credentialOwner` pass-through: when the parent has no auth
                // anywhere in its chain, the derived profile starts with no
                // auth either — propagate nil so the providers card shows the
                // "no authentication set" prompt instead of claiming the
                // parent owns credentials it doesn't have.
                let synthesized = ProfileEditorResponse(
                    raw: emptyRaw,
                    resolved: parentPayload.resolved,
                    parent: parentPayload.resolved,
                    sourceMap: sourceMap,
                    credentialOwner: parentPayload.credentialOwner
                )
                await MainActor.run {
                    self.editorPayload = synthesized
                    self.mergeStrategyDraft = [:]
                    self.initialMergeStrategy = [:]
                    let inherited = Set(allKeys)
                    self.inheritedFields = inherited
                    self.initialInheritedFields = []
                    self.editorLoadState = .loaded
                }
                return
            }
            let payload = try await onLoadEditor(profile.name)
            await MainActor.run {
                self.editorPayload = payload
                var draft: [String: MergeMode] = [:]
                for (key, raw) in (payload.raw.mergeStrategy ?? [:]) {
                    if let mode = MergeMode(rawValue: raw) { draft[key] = mode }
                }
                self.mergeStrategyDraft = draft
                self.initialMergeStrategy = draft
                let inherited = Set(
                    payload.sourceMap.filter { $0.value == .inherited }.map { $0.key }
                )
                self.inheritedFields = inherited
                self.initialInheritedFields = inherited
                self.editorLoadState = .loaded
            }
        } catch {
            await MainActor.run {
                self.editorLoadState = .failed(error.localizedDescription)
            }
        }
    }

    /// Returns the per-field source classification, taking into account
    /// any user toggles made in this session.
    private func fieldSource(_ fieldName: String) -> FieldSource? {
        guard editorPayload != nil, profile.extendsProfile != nil else { return nil }
        if inheritedFields.contains(fieldName) { return .inherited }
        // Anything the user hasn't explicitly marked inherited that has a
        // local value is considered 'own'. Merge-special fields may want
        // .merged when mode == .merge; handled by fieldSourceForMergeable.
        return .own
    }

    /// Source classification for one of the six merge-special fields.
    /// Returns `.merged` when the user hasn't chosen `replace` and both
    /// sides contribute values; otherwise delegates to `fieldSource`.
    private func mergeableFieldSource(_ fieldName: String) -> FieldSource? {
        guard let payload = editorPayload, profile.extendsProfile != nil else { return nil }
        if inheritedFields.contains(fieldName) { return .inherited }
        let mode = mergeStrategyDraft[fieldName] ?? .merge
        if mode == .replace { return .own }
        return payload.sourceMap[fieldName] == .inherited ? .inherited : .merged
    }

    private var parentDisplayName: String? {
        editorPayload?.parent?.name
    }

    private func bindingForMergeMode(_ field: String) -> Binding<MergeMode> {
        Binding(
            get: { mergeStrategyDraft[field] ?? .merge },
            set: { mergeStrategyDraft[field] = $0 }
        )
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
                case .sandbox:      sandboxFields
                case .actions:      actionFields
                case .issueWatcher: issueWatcherFields
                case .validation:   validationFields
                case .credentials:  credentialFields
                case .injections:   injectionFields
                case .memory:       memorySection
                case .deployment:   deploymentFields
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
        VStack(spacing: 8) {
            if let saveError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                    Text(saveError)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                if !isNew, onDelete != nil {
                    Button("Delete", role: .destructive) {
                        showDeleteConfirmation = true
                    }
                        .foregroundStyle(.red)
                        .disabled(isSaving || isDeleting)
                }
                Spacer()
                if isSaving || isDeleting {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(isSaving || isDeleting)
                Button(isNew ? "Create" : "Save") {
                    submit()
                }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        isSaving
                        || isDeleting
                        || (isNew && profile.name.isEmpty)
                        || (showOverridesView && editorLoadState != .loaded)
                    )
            }
        }
        .padding(16)
        .confirmationDialog(
            "Delete profile “\(profile.name)”?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { deleteProfile() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This cannot be undone. Pods using this profile keep running, but no new pods can be created from it.")
        }
    }

    private func deleteProfile() {
        guard let onDelete else { return }
        isDeleting = true
        saveError = nil
        let name = profile.name
        Task {
            do {
                try await onDelete(name)
                await MainActor.run {
                    isDeleting = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isDeleting = false
                    saveError = error.localizedDescription
                }
            }
        }
    }

    private func submit() {
        isSaving = true
        saveError = nil
        Task {
            do {
                // Prefer the inheritance-aware save/create paths when the
                // editor payload was loaded so inherited fields get stripped
                // instead of echoed back as explicit overrides.
                if isNew, editorPayload != nil, let handler = onCreateWithInheritance {
                    let strategy: [String: MergeMode] =
                        mergeStrategyDraft.isEmpty ? [:] : mergeStrategyDraft
                    try await handler(profile, inheritedFields, strategy)
                } else if !isNew, editorPayload != nil, let handler = onSaveWithInheritance {
                    let strategy: [String: MergeMode] =
                        mergeStrategyDraft == initialMergeStrategy ? [:] : mergeStrategyDraft
                    try await handler(profile, inheritedFields, initialInheritedFields, strategy)
                } else if let onSave {
                    try await onSave(profile)
                } else {
                    await MainActor.run { dismiss() }
                    return
                }
                await MainActor.run {
                    isSaving = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                    saveError = error.localizedDescription
                }
            }
        }
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
        inheritableFieldRow(
            "Build Command",
            fieldName: "buildCommand",
            help: "Compiles the project. Runs after repo clone inside the container."
        ) {
            TextField("npm run build", text: $profile.buildCommand)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
                .disabled(inheritedFields.contains("buildCommand"))
        }
        inheritableFieldRow(
            "Start Command",
            fieldName: "startCommand",
            help: "Starts the app server for health checks and smoke testing."
        ) {
            TextField("npm start", text: $profile.startCommand)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
                .disabled(inheritedFields.contains("startCommand"))
        }
        fieldRow("Test Command", help: "Runs after build to verify tests pass. Leave empty to skip.") {
            TextField("Optional", text: Binding(
                get: { profile.testCommand ?? "" },
                set: { profile.testCommand = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }
        fieldRow("Lint Command", help: "Runs before build. Common: 'npm run lint', 'biome check'. Leave empty to skip.") {
            TextField("Optional", text: Binding(
                get: { profile.lintCommand ?? "" },
                set: { profile.lintCommand = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }
        fieldRow("SAST Command", help: "Static security analysis. Runs after lint. Common: 'semgrep ci', 'snyk test'. Leave empty to skip.") {
            TextField("Optional", text: Binding(
                get: { profile.sastCommand ?? "" },
                set: { profile.sastCommand = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }
        fieldRow("Build Env", help: "Env vars merged into validation phase execs (build/test/lint/sast). Common use: NODE_OPTIONS=--max-old-space-size=4096 for memory-heavy production bundles. Does not affect the agent's runtime env.") {
            BuildEnvEditor(env: $profile.buildEnv)
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
        HStack(spacing: 24) {
            fieldRow("Lint", help: "Max seconds for the lint command before it's killed.") {
                Stepper("\(profile.lintTimeout ?? 120)s", value: Binding(
                    get: { profile.lintTimeout ?? 120 },
                    set: { profile.lintTimeout = $0 }
                ), in: 10...600, step: 10)
                    .frame(width: 110)
            }
            fieldRow("SAST", help: "Max seconds for the SAST command before it's killed.") {
                Stepper("\(profile.sastTimeout ?? 300)s", value: Binding(
                    get: { profile.sastTimeout ?? 300 },
                    set: { profile.sastTimeout = $0 }
                ), in: 10...1800, step: 30)
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
            fieldRow("Reviewer Model", help: "Model used for AC validation and task review. Sonnet is sufficient for automated checks.") {
                Picker("", selection: $profile.reviewerModel) {
                    Text("Sonnet").tag("sonnet")
                    Text("Opus").tag("opus")
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

    // MARK: - Sandbox & Test Pipeline

    @ViewBuilder
    private var sandboxFields: some View {
        Toggle(isOn: $profile.trustedSource) {
            HStack(spacing: 4) {
                Text("Trusted source")
                HelpBadge(text: "Gates privileged sidecars (currently: Dagger engine). Only enable for internal repos with reviewed PRs — privileged sidecars can access the pod's entire filesystem and network.")
            }
        }

        if profile.trustedSource {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Privileged sidecars (Dagger engine, etc.) can be spawned for pods using this profile. Do not enable on public-PR / OSS profiles.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }

        Divider().padding(.vertical, 8)

        let tpEnabledBinding = Binding<Bool>(
            get: { profile.testPipeline?.enabled ?? false },
            set: { newValue in
                if newValue {
                    if profile.testPipeline == nil {
                        profile.testPipeline = TestPipelineConfig(enabled: true)
                    } else {
                        profile.testPipeline?.enabled = true
                    }
                } else {
                    profile.testPipeline?.enabled = false
                }
            }
        )

        Toggle(isOn: tpEnabledBinding) {
            HStack(spacing: 4) {
                Text("Enable ADO test pipeline")
                HelpBadge(text: "Lets the agent trigger a pre-configured ADO pipeline via `ado_run_test_pipeline`. The daemon pushes the pod's branch to a test repo; the test pipeline runs with sandbox credentials stored in ADO variable groups — never in the pod.")
            }
        }

        if profile.testPipeline?.enabled == true {
            let tpBinding = Binding<TestPipelineConfig>(
                get: { profile.testPipeline ?? TestPipelineConfig(enabled: true) },
                set: { profile.testPipeline = $0 }
            )

            fieldRow("Test Repo URL", help: "Full ADO repo URL (e.g. https://dev.azure.com/org/project/_git/test-repo). Keep this separate from the main repo so the test pipeline can't accidentally fire production stages.") {
                TextField("https://dev.azure.com/org/project/_git/test-repo",
                          text: Binding(
                            get: { tpBinding.wrappedValue.testRepo },
                            set: { tpBinding.wrappedValue.testRepo = $0 }
                          ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
            }

            fieldRow("Test Pipeline ID", help: "Numeric ID of the ADO pipeline definition to trigger. Find it in the URL of the pipeline's ADO page.") {
                TextField("42", value: Binding(
                    get: { tpBinding.wrappedValue.testPipelineId },
                    set: { tpBinding.wrappedValue.testPipelineId = $0 }
                ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
            }

            fieldRow("Rate Limit (per hour)", help: "Max test pipeline runs per pod per hour. Leave blank for the default (10). Prevents runaway agents burning ADO minutes.") {
                TextField("10", value: Binding(
                    get: { tpBinding.wrappedValue.rateLimitPerHour ?? 0 },
                    set: { tpBinding.wrappedValue.rateLimitPerHour = $0 == 0 ? nil : $0 }
                ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
            }

            fieldRow("Branch Prefix", help: "Prefix for the temp branches the daemon pushes to the test repo. Must end with '/'. Default: test-runs/") {
                TextField("test-runs/", text: Binding(
                    get: { tpBinding.wrappedValue.branchPrefix ?? "" },
                    set: { tpBinding.wrappedValue.branchPrefix = $0.isEmpty ? nil : $0 }
                ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 240)
            }

            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .foregroundStyle(.blue)
                Text("The test pipeline YAML (in the test repo) must trigger on `branches: include: [test-runs/*]`. Its ADO variable groups hold real credentials — keep the YAML owned by the team, never modifiable by the agent.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 8)
        }

        Divider().padding(.vertical, 8)

        daggerSidecarSubsection
    }

    /// Editable config for the Dagger engine sidecar. Two-layer gate:
    ///  - `trustedSource` must be on (privileged-sidecar trust)
    ///  - `sidecars.dagger.enabled` must be on (the toggle here)
    /// Both must flip on for pods to actually be able to request `dagger`.
    @ViewBuilder
    private var daggerSidecarSubsection: some View {
        // Binding reads `sidecars.dagger.enabled`; writing creates the nested
        // config on first-enable so the form fields have somewhere to bind.
        let enabledBinding = Binding<Bool>(
            get: { profile.sidecars?.dagger?.enabled ?? false },
            set: { newValue in
                if newValue {
                    if profile.sidecars == nil {
                        profile.sidecars = SidecarsSnapshot(
                            dagger: DaggerSidecarSnapshot(
                                enabled: true,
                                // Paste a pinned digest before saving. Enforced
                                // server-side by /@sha256:[0-9a-f]{64}$/.
                                engineImageDigest: "",
                                engineVersion: "v0.18.6"
                            )
                        )
                    } else if profile.sidecars?.dagger == nil {
                        profile.sidecars?.dagger = DaggerSidecarSnapshot(
                            enabled: true,
                            engineImageDigest: "",
                            engineVersion: "v0.18.6"
                        )
                    } else {
                        profile.sidecars?.dagger?.enabled = true
                    }
                } else {
                    profile.sidecars?.dagger?.enabled = false
                }
            }
        )

        HStack(spacing: 6) {
            Image(systemName: "cube.box")
                .foregroundStyle(.purple)
            Text("Dagger sidecar")
                .font(.subheadline.weight(.medium))
            HelpBadge(text: "Spawns a privileged Dagger engine container alongside pods that set requireSidecars: [dagger]. Required for briefs that run dagger CLI / import the Dagger SDK. Needs Trusted source enabled (above).")
            Spacer()
        }

        Toggle(isOn: enabledBinding) {
            Text(profile.sidecars?.dagger?.enabled == true
                ? "Enable Dagger engine config"
                : "Enable Dagger engine config")
                .font(.callout)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .disabled(!profile.trustedSource)

        if !profile.trustedSource {
            Text("Turn on Trusted source above to configure the Dagger engine.")
                .font(.caption2)
                .foregroundStyle(.orange)
        }

        if profile.sidecars?.dagger != nil {
            let digestBinding = Binding<String>(
                get: { profile.sidecars?.dagger?.engineImageDigest ?? "" },
                set: { profile.sidecars?.dagger?.engineImageDigest = $0 }
            )
            let versionBinding = Binding<String>(
                get: { profile.sidecars?.dagger?.engineVersion ?? "" },
                set: { profile.sidecars?.dagger?.engineVersion = $0 }
            )

            fieldRow("Engine image digest", help: "Pinned Dagger engine image. Must match /@sha256:[0-9a-f]{64}$/ — the daemon rejects rolling tags. Example: registry.dagger.io/engine@sha256:abc… (64 hex chars). Get it from `docker pull registry.dagger.io/engine:<version>` + `docker inspect`.") {
                TextField(
                    "registry.dagger.io/engine@sha256:…",
                    text: digestBinding
                )
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
            }

            fieldRow("Engine version", help: "Human-readable version label for audit logs. Should match the SDK version baked into the stack image (v0.18.6 for dotnet10-go / go124 / go124-pw).") {
                TextField("v0.18.6", text: versionBinding)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 140)
            }

            let digest = profile.sidecars?.dagger?.engineImageDigest ?? ""
            let digestRegex = #/@sha256:[0-9a-f]{64}$/#
            let digestLooksValid = (try? digestRegex.firstMatch(in: digest)) ?? nil != nil

            if !digest.isEmpty && !digestLooksValid {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text("Digest must end with @sha256:<64 hex chars>. The daemon will reject rolling tags.")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            } else if digest.isEmpty && profile.sidecars?.dagger?.enabled == true {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.orange)
                    Text("Paste a pinned digest before saving — required for pods to spawn the sidecar.")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
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

            // On derived profiles, let the user choose whether their smoke
            // pages append to the parent's or replace them entirely.
            if editorPayload != nil, profile.extendsProfile != nil {
                HStack(spacing: 6) {
                    Text("Smoke Pages — Merge Mode")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                MergeModePicker(
                    mode: bindingForMergeMode("smokePages"),
                    fieldLabel: "Smoke pages",
                    parentName: parentDisplayName
                )
                .padding(.bottom, 4)
            }

            fieldRow("Smoke Pages", help: "Each page is loaded in a headless browser after the app starts. Verifies the app renders correctly.") {
            VStack(alignment: .leading, spacing: 6) {
                // Show parent's entries read-only when we're in merge mode.
                if let parent = editorPayload?.parent,
                   !parent.smokePages.isEmpty,
                   (mergeStrategyDraft["smokePages"] ?? .merge) == .merge {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("From \(parent.name)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        ForEach(parent.smokePages.indices, id: \.self) { i in
                            Text(parent.smokePages[i].path)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 1)
                        }
                        Divider().padding(.vertical, 2)
                    }
                }
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

        Divider().padding(.vertical, 4)

        fieldRow("Merge Poll Interval", help: "How often the daemon checks the PR for CI / review changes. Defaults to 60s. Lower values surface failures faster on actively-watched profiles at the cost of more API calls.") {
            HStack(spacing: 4) {
                Stepper("\(profile.mergePollIntervalSec ?? 60)s", value: Binding(
                    get: { profile.mergePollIntervalSec ?? 60 },
                    set: { profile.mergePollIntervalSec = $0 }
                ), in: 5...3600)
                .frame(width: 140)
                if profile.mergePollIntervalSec != nil {
                    Button("Reset") { profile.mergePollIntervalSec = nil }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
            }
        }

        fieldRow("Fix-Pod Cooldown", help: "Minimum delay between PR-fix-pod spawns on the same parent pod. Defaults to 600s (10 min); 0 disables the cooldown so iterations can run back-to-back.") {
            HStack(spacing: 4) {
                Stepper("\(profile.fixPodCooldownSec ?? 600)s", value: Binding(
                    get: { profile.fixPodCooldownSec ?? 600 },
                    set: { profile.fixPodCooldownSec = $0 }
                ), in: 0...3600, step: 30)
                .frame(width: 140)
                if profile.fixPodCooldownSec != nil {
                    Button("Reset") { profile.fixPodCooldownSec = nil }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
            }
        }

        Toggle(isOn: $profile.reuseFixPod) {
            HStack(spacing: 4) {
                Text("Reuse Fix Pod")
                HelpBadge(text: "When on, the daemon recycles a single fix pod entity per parent PR across all rounds of CI / review feedback. Surfaces as one pod with an iteration counter rather than a chain of separate fix pods.")
            }
        }
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
               isInherited: inheritedFields.contains("githubPat"),
               help: "Personal access token for GitHub — needed for PR creation and private repo cloning.")
        patRow("ADO PAT", value: $profile.adoPat, isSet: profile.hasAdoPat,
               isInherited: inheritedFields.contains("adoPat"),
               help: "Azure DevOps token — needed for ADO repos, PRs, and package feeds.")
        patRow("Registry PAT", value: $profile.registryPat, isSet: profile.hasRegistryPat,
               isInherited: inheritedFields.contains("registryPat"),
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

    // MARK: - Deployment

    @ViewBuilder
    private var deploymentFields: some View {
        fieldRow("Enabled", help: "Allow agents to invoke `run_deploy_script` for this profile. Off by default — turn on after you've reviewed the env-var values and (optionally) the script allowlist.") {
            Toggle(isOn: $profile.deploymentEnabled) {
                Text(profile.deploymentEnabled ? "Deployment enabled" : "Deployment disabled")
                    .font(.callout)
            }
            .toggleStyle(.switch)
        }

        Divider().padding(.vertical, 4)

        fieldRow("Environment Variables", help: "Injected into deploy script execs via `docker exec --env`. Never written into the container's persistent env, so agents can't read them passively. Prefix a value with `$DAEMON:VAR_NAME` to resolve it from the daemon's process environment at execution time — use this for secrets. Plaintext values are stored as-is — use this for non-sensitive targeting config like resource group names or regions.") {
            DeploymentEnvEditor(env: $profile.deploymentEnv)
        }

        Divider().padding(.vertical, 4)

        fieldRow("Allowed Scripts", help: "Optional glob allowlist relative to `/workspace`. When non-empty, only script paths matching one of these globs may be executed. Supports `*` wildcards (e.g. `scripts/deploy-*.sh`). Leave empty to allow any script the agent invokes (the human approval gate still applies).") {
            DeploymentAllowedScriptsEditor(scripts: $profile.deploymentAllowedScripts)
        }
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
            VStack(alignment: .leading, spacing: 10) {
                ForEach(profile.skills.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 4) {
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
                        HStack(spacing: 6) {
                            Picker("", selection: $profile.skills[i].sourceType) {
                                Text("local").tag("local")
                                Text("github").tag("github")
                            }
                            .pickerStyle(.segmented)
                            .frame(width: 140)
                            .labelsHidden()

                            if profile.skills[i].sourceType == "local" {
                                TextField(
                                    "absolute or cwd-relative path to .md file",
                                    text: $profile.skills[i].localPath
                                )
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                            } else {
                                TextField("owner/repo", text: $profile.skills[i].githubRepo)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.caption, design: .monospaced))
                                    .frame(width: 160)
                                TextField(
                                    "path (defaults to <name>.md)",
                                    text: $profile.skills[i].githubPath
                                )
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                                TextField("ref (default: main)", text: $profile.skills[i].githubRef)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.caption, design: .monospaced))
                                    .frame(width: 110)
                            }
                        }
                        .padding(.leading, 4)
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

        Divider().padding(.vertical, 8)

        // Code intelligence — LSP-backed stdio MCP servers pre-installed in the image
        Text("Code Intelligence")
            .font(.caption)
            .foregroundStyle(.secondary)

        Toggle(isOn: $profile.codeIntelligenceSerena) {
            HStack(spacing: 4) {
                Text("Serena (LSP navigation)")
                HelpBadge(text: "Installs Serena via pip and injects it as a stdio MCP server. Provides cross-file type navigation, go-to-definition, find-all-references, and barrel-export resolution for TypeScript, C#, and Python. Requires Python in the container image.")
            }
        }

        Toggle(isOn: $profile.codeIntelligenceRoslynCodeLens) {
            HStack(spacing: 4) {
                Text("Roslyn CodeLens (C# DI analysis)")
                HelpBadge(text: "Installs roslyn-codelens-mcp and injects it as a stdio MCP server. Exposes get_di_registrations and find_implementations for DI-heavy C# codebases. Requires a dotnet template.")
            }
        }
        .disabled(profile.template != .dotnet9 && profile.template != .dotnet10 && profile.template != .dotnet10Go)

        if profile.codeIntelligenceRoslynCodeLens && profile.template != .dotnet9 && profile.template != .dotnet10 && profile.template != .dotnet10Go {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Roslyn CodeLens requires a dotnet template (dotnet9, dotnet10, or dotnet10-go).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 6))
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

    /// `fieldRow` variant that renders an Inheritance chip when the profile
    /// is derived and a source map has loaded. Wraps the passed content in
    /// an override-aware container: the caller supplies the normal input
    /// (e.g. a TextField) and is responsible for disabling it when the
    /// field is inherited.
    @ViewBuilder
    private func inheritableFieldRow<Content: View>(
        _ label: String,
        fieldName: String,
        help: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let help {
                    HelpBadge(text: help)
                }
                if let source = fieldSource(fieldName) {
                    InheritanceChip(
                        source: source,
                        parentName: parentDisplayName,
                        onOverride: { inheritedFields.remove(fieldName) },
                        onReset: { inheritedFields.insert(fieldName) }
                    )
                }
            }
            content()
        }
    }

    // MARK: - Overrides view (derived profiles)

    /// Full list of fields the overrides editor knows how to render. Driven
    /// by `ProfileOverrideCatalog.all` — add new fields to the catalog and
    /// a case to `overrideCard(for:)`.
    private var overridableFields: [ProfileOverrideField] {
        ProfileOverrideCatalog.all
    }

    private var currentOverrides: [ProfileOverrideField] {
        overridableFields.filter { !inheritedFields.contains($0.key) }
    }

    private var availableToOverride: [ProfileOverrideField] {
        overridableFields.filter { inheritedFields.contains($0.key) }
    }

    @ViewBuilder
    private var overridesView: some View {
        VStack(spacing: 0) {
            overridesTopBar
            Divider()
            switch editorLoadState {
            case .idle, .loading:
                overridesLoadingState
            case .failed(let message):
                overridesErrorState(message)
            case .loaded:
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        // Providers card is always visible on derived profiles —
                        // auth is high-touch and needs to be discoverable even
                        // when it's currently inherited from the parent.
                        providersCard

                        if currentOverrides.isEmpty {
                            overridesEmptyState
                        } else {
                            HStack(spacing: 6) {
                                Text("Your overrides")
                                    .font(.system(.callout).weight(.semibold))
                                Text("(\(currentOverrides.count))")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                            .padding(.bottom, 2)
                            ForEach(currentOverrides) { field in
                                overrideCard(for: field)
                            }
                        }
                        addOverrideRow
                    }
                    .padding(20)
                }
            }
        }
    }

    private var overridesLoadingState: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.regular)
            Text("Loading inheritance data…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func overridesErrorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundStyle(.orange)
            Text("Couldn't load inheritance data")
                .font(.callout.weight(.semibold))
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button {
                Task { await loadEditorPayloadIfNeeded() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    // MARK: - Providers (always-visible auth card)

    /// Special-case card: shows who owns the credentials and gives a way to
    /// authenticate — either re-auth the owner (from this view) or break
    /// inheritance and auth on this profile directly. Always visible so
    /// users don't have to fish for it in the Add menu.
    @ViewBuilder
    private var providersCard: some View {
        let ownerName = editorPayload?.credentialOwner
        let isOwnerSelf = ownerName == profile.name
        let resolvedProvider = editorPayload?.resolved.modelProvider ?? profile.modelProvider.rawValue

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "person.badge.key")
                    .foregroundStyle(.secondary)
                Text("Authentication")
                    .font(.callout.weight(.semibold))
                Text("Providers")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                Spacer()
                Text("Provider: \(resolvedProvider)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if let ownerName, !isOwnerSelf {
                // Inherited auth — read-only state + explicit break-inheritance.
                HStack(spacing: 6) {
                    Image(systemName: "arrow.turn.down.right")
                        .foregroundStyle(.green)
                    Text("Authenticated via")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(ownerName)
                        .font(.system(.caption, design: .monospaced).weight(.medium))
                    Spacer()
                }
                Text("This profile inherits its \(resolvedProvider.uppercased()) credentials from **\(ownerName)**. Token rotations during pod runs are saved on the owner — one login covers the whole family.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button {
                        startAuth(provider: resolvedProvider, label: providerAuthLabel(resolvedProvider))
                    } label: {
                        Label("Authenticate here (break inheritance)", systemImage: "person.crop.circle.badge.plus")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    Spacer()
                }
                authStatusView
            } else if ownerName == nil {
                // No auth anywhere in the chain.
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("No authentication set for this profile family")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if providerNeedsAuth(resolvedProvider) {
                    Button {
                        startAuth(provider: resolvedProvider, label: providerAuthLabel(resolvedProvider))
                    } label: {
                        Label("Authenticate with \(providerAuthLabel(resolvedProvider))", systemImage: "person.crop.circle.badge.plus")
                            .font(.callout)
                    }
                    .buttonStyle(.bordered)
                    authStatusView
                }
            } else {
                // Owned by self.
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    Text("This profile owns its authentication")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if providerNeedsAuth(resolvedProvider) {
                    Button {
                        startAuth(provider: resolvedProvider, label: providerAuthLabel(resolvedProvider))
                    } label: {
                        Label("Re-authenticate with \(providerAuthLabel(resolvedProvider))", systemImage: "arrow.clockwise")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    authStatusView
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.blue.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.blue.opacity(0.25), lineWidth: 1)
        )
    }

    private func providerNeedsAuth(_ provider: String) -> Bool {
        provider == "max" || provider == "copilot"
    }

    private func providerAuthLabel(_ provider: String) -> String {
        switch provider {
        case "max":     return "Claude MAX"
        case "copilot": return "GitHub Copilot"
        default:        return provider
        }
    }

    @ViewBuilder
    private var authStatusView: some View {
        if let status = authStatus {
            switch status {
            case .inProgress(let label):
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Authenticating with \(label)…")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            case .success(let msg):
                Label(msg, systemImage: "checkmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.green)
            case .failure(let msg):
                Label(msg, systemImage: "xmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var overridesTopBar: some View {
        VStack(spacing: 10) {
            if isNew {
                HStack(spacing: 10) {
                    Image(systemName: "tag")
                        .foregroundStyle(.secondary)
                        .font(.system(size: 12))
                    Text("Name")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("my-derived-profile", text: $profile.name)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                        .frame(maxWidth: 320)
                    Spacer()
                }
            }
            HStack(spacing: 10) {
                Image(systemName: "arrow.turn.down.right")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 12))
                Text("Extends")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(editorPayload?.parent?.name ?? profile.extendsProfile ?? "—")
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                Spacer()
                Button {
                    // placeholder for the parent-browser drawer
                } label: {
                    Label("View parent values", systemImage: "sidebar.right")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("Coming soon — read-only browser of the resolved parent profile")
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.4))
    }

    private var overridesEmptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            Text("Inheriting everything from \(editorPayload?.parent?.name ?? "parent")")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("This profile currently behaves identically to its parent. Add an override to deviate.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    @ViewBuilder
    private var addOverrideRow: some View {
        if !availableToOverride.isEmpty {
            Menu {
                ForEach(ProfileOverrideFieldSection.allCases, id: \.self) { section in
                    let items = availableToOverride.filter { $0.section == section }
                    if !items.isEmpty {
                        Section(section.rawValue) {
                            ForEach(items) { field in
                                Button(field.label) {
                                    inheritedFields.remove(field.key)
                                }
                            }
                        }
                    }
                }
            } label: {
                Label("Add override…", systemImage: "plus.circle")
                    .font(.callout)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(.quaternary, style: StrokeStyle(lineWidth: 1, dash: [4]))
                    )
            }
            .menuStyle(.borderlessButton)
            .padding(.top, 4)
        }
    }

    // MARK: - Override cards — dispatch

    @ViewBuilder
    private func overrideCard(for field: ProfileOverrideField) -> some View {
        switch field.key {
        // MARK: General
        case "repoUrl":
            stringCard(field, value: $profile.repoUrl,
                       parent: editorPayload?.parent?.repoUrl ?? "",
                       placeholder: "https://github.com/org/repo.git")
        case "defaultBranch":
            stringCard(field, value: $profile.defaultBranch,
                       parent: editorPayload?.parent?.defaultBranch ?? "",
                       placeholder: "main")
        case "branchPrefix":
            stringCard(field, value: $profile.branchPrefix,
                       parent: editorPayload?.parent?.branchPrefix ?? "autopod/",
                       placeholder: "autopod/")
        case "template":
            enumCard(field, selection: $profile.template,
                     options: StackTemplate.allCases.map { ($0, $0.label) },
                     parent: editorPayload?.parent?.template ?? "")
        case "pod":
            podCard(field)
        case "workerProfile":
            nullableStringCard(field,
                value: Binding(
                    get: { profile.workerProfile ?? "" },
                    set: { profile.workerProfile = $0.isEmpty ? nil : $0 }
                ),
                parent: editorPayload?.parent?.workerProfile ?? "",
                placeholder: "Worker profile name")

        // MARK: Build & Run
        case "buildCommand":
            stringCard(field, value: $profile.buildCommand,
                       parent: editorPayload?.parent?.buildCommand ?? "",
                       placeholder: "npm run build")
        case "startCommand":
            stringCard(field, value: $profile.startCommand,
                       parent: editorPayload?.parent?.startCommand ?? "",
                       placeholder: "npm start")
        case "buildWorkDir":
            nullableStringCard(field,
                value: Binding(
                    get: { profile.buildWorkDir ?? "" },
                    set: { profile.buildWorkDir = $0.isEmpty ? nil : $0 }
                ),
                parent: editorPayload?.parent?.buildWorkDir ?? "",
                placeholder: "apps/web")
        case "testCommand":
            nullableStringCard(field,
                value: Binding(
                    get: { profile.testCommand ?? "" },
                    set: { profile.testCommand = $0.isEmpty ? nil : $0 }
                ),
                parent: editorPayload?.parent?.testCommand ?? "",
                placeholder: "pnpm test")
        case "buildEnv":
            buildEnvOverrideCard(field: field)
        case "lintCommand":
            nullableStringCard(field,
                value: Binding(
                    get: { profile.lintCommand ?? "" },
                    set: { profile.lintCommand = $0.isEmpty ? nil : $0 }
                ),
                parent: editorPayload?.parent?.lintCommand ?? "",
                placeholder: "biome lint .")
        case "lintTimeout":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.lintTimeout },
                    set: { profile.lintTimeout = $0 }
                ),
                parent: editorPayload?.parent?.lintTimeout,
                placeholder: "120")
        case "sastCommand":
            nullableStringCard(field,
                value: Binding(
                    get: { profile.sastCommand ?? "" },
                    set: { profile.sastCommand = $0.isEmpty ? nil : $0 }
                ),
                parent: editorPayload?.parent?.sastCommand ?? "",
                placeholder: "semgrep --config=p/security-audit .")
        case "sastTimeout":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.sastTimeout },
                    set: { profile.sastTimeout = $0 }
                ),
                parent: editorPayload?.parent?.sastTimeout,
                placeholder: "300")
        case "healthPath":
            stringCard(field, value: $profile.healthPath,
                       parent: editorPayload?.parent?.healthPath ?? "/",
                       placeholder: "/")
        case "healthTimeout":
            intCard(field, value: $profile.healthTimeout,
                    parent: editorPayload?.parent?.healthTimeout, range: 10...600, unit: "s")
        case "buildTimeout":
            intCard(field, value: $profile.buildTimeout,
                    parent: editorPayload?.parent?.buildTimeout, range: 30...1800, unit: "s")
        case "testTimeout":
            intCard(field, value: $profile.testTimeout,
                    parent: editorPayload?.parent?.testTimeout, range: 30...3600, unit: "s")

        // MARK: Agent
        case "defaultModel":
            stringCard(field, value: $profile.defaultModel,
                       parent: editorPayload?.parent?.defaultModel ?? "",
                       placeholder: "opus")
        case "reviewerModel":
            stringCard(field, value: $profile.reviewerModel,
                       parent: editorPayload?.parent?.reviewerModel ?? "",
                       placeholder: profile.defaultModel)
        case "defaultRuntime":
            enumCard(field, selection: $profile.defaultRuntime,
                     options: RuntimeType.allCases.map { ($0, $0.rawValue.capitalized) },
                     parent: editorPayload?.parent?.defaultRuntime ?? "")
        case "customInstructions":
            nullableTextOverrideCard(field: field,
                value: Binding(
                    get: { profile.customInstructions ?? "" },
                    set: { profile.customInstructions = $0.isEmpty ? nil : $0 }
                ),
                parentValue: editorPayload?.parent?.customInstructions ?? "")

        // MARK: Providers
        case "modelProvider":
            enumCard(field, selection: $profile.modelProvider,
                     options: ModelProvider.allCases.map { ($0, $0.rawValue.capitalized) },
                     parent: editorPayload?.parent?.modelProvider ?? "")
        case "prProvider":
            enumCard(field, selection: $profile.prProvider,
                     options: PRProvider.allCases.map { ($0, $0.label) },
                     parent: editorPayload?.parent?.prProvider ?? "")

        // MARK: Escalation
        case "escalation":
            escalationCard(field)
        case "tokenBudget":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.tokenBudget },
                    set: { profile.tokenBudget = $0 }
                ),
                parent: editorPayload?.parent?.tokenBudget,
                placeholder: "Unlimited")
        case "tokenBudgetPolicy":
            enumCard(field, selection: $profile.tokenBudgetPolicy,
                     options: TokenBudgetPolicy.allCases.map { ($0, $0.label) },
                     parent: editorPayload?.parent?.tokenBudgetPolicy ?? "")
        case "tokenBudgetWarnAt":
            doubleCard(field, value: $profile.tokenBudgetWarnAt,
                       parent: editorPayload?.parent?.tokenBudgetWarnAt,
                       range: 0.1...0.99, format: "%.2f")
        case "maxBudgetExtensions":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.maxBudgetExtensions },
                    set: { profile.maxBudgetExtensions = $0 }
                ),
                parent: editorPayload?.parent?.maxBudgetExtensions,
                placeholder: "Unlimited")

        // MARK: Container
        case "executionTarget":
            enumCard(field, selection: $profile.executionTarget,
                     options: ExecutionTarget.allCases.map { ($0, $0.label) },
                     parent: editorPayload?.parent?.executionTarget ?? "")
        case "containerMemoryGb":
            nullableDoubleCard(field,
                value: Binding(
                    get: { profile.containerMemoryGb },
                    set: { profile.containerMemoryGb = $0 }
                ),
                parent: editorPayload?.parent?.containerMemoryGb,
                placeholder: "Docker default")

        // MARK: Network & Security / Actions (composite — full editors)
        case "networkPolicy":
            networkPolicyOverrideCard(field: field)
        case "securityScan":
            securityScanOverrideCard(field: field)
        case "actionPolicy":
            actionPolicyOverrideCard(field: field)
        case "pimActivations":
            pimActivationsOverrideCard(field: field)

        // MARK: Issue Watcher
        case "issueWatcherEnabled":
            boolCard(field, value: $profile.issueWatcherEnabled,
                     parent: editorPayload?.parent?.issueWatcherEnabled)
        case "issueWatcherLabelPrefix":
            stringCard(field, value: $profile.issueWatcherLabelPrefix,
                       parent: editorPayload?.parent?.issueWatcherLabelPrefix ?? "autopod",
                       placeholder: "autopod")

        // MARK: Validation
        case "hasWebUi":
            boolCard(field, value: $profile.hasWebUi,
                     parent: editorPayload?.parent?.hasWebUi)
        case "maxValidationAttempts":
            intCard(field, value: $profile.maxValidationAttempts,
                    parent: editorPayload?.parent?.maxValidationAttempts,
                    range: 1...10, unit: "attempts")
        case "smokePages":
            smokePagesOverrideCard(field: field)
        case "mergePollIntervalSec":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.mergePollIntervalSec },
                    set: { profile.mergePollIntervalSec = $0 }
                ),
                parent: editorPayload?.parent?.mergePollIntervalSec,
                placeholder: "60")
        case "fixPodCooldownSec":
            nullableIntCard(field,
                value: Binding(
                    get: { profile.fixPodCooldownSec },
                    set: { profile.fixPodCooldownSec = $0 }
                ),
                parent: editorPayload?.parent?.fixPodCooldownSec,
                placeholder: "600")
        case "reuseFixPod":
            boolCard(field, value: $profile.reuseFixPod,
                     parent: editorPayload?.parent?.reuseFixPod)

        // MARK: Credentials
        case "githubPat":
            patCard(field,
                value: Binding(
                    get: { profile.githubPat ?? "" },
                    set: { profile.githubPat = $0.isEmpty ? nil : $0 }
                ),
                isSet: profile.hasGithubPat)
        case "adoPat":
            patCard(field,
                value: Binding(
                    get: { profile.adoPat ?? "" },
                    set: { profile.adoPat = $0.isEmpty ? nil : $0 }
                ),
                isSet: profile.hasAdoPat)
        case "registryPat":
            patCard(field,
                value: Binding(
                    get: { profile.registryPat ?? "" },
                    set: { profile.registryPat = $0.isEmpty ? nil : $0 }
                ),
                isSet: profile.hasRegistryPat)

        // MARK: Injections (merge-special)
        case "mcpServers":
            mcpServersOverrideCard(field: field)
        case "claudeMdSections":
            claudeMdSectionsOverrideCard(field: field)
        case "skills":
            skillsOverrideCard(field: field)
        case "privateRegistries":
            privateRegistriesOverrideCard(field: field)
        case "codeIntelligence":
            codeIntelligenceOverrideCard(field: field)

        // MARK: Deployment
        case "deployment":
            deploymentOverrideCard(field: field)

        default:
            // Placeholder for unmapped keys — shouldn't fire with a full catalog.
            overrideCardShell(field: field) {
                Text("No editor available for `\(field.key)` yet.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Override card renderers — primitives

    private func stringCard(
        _ field: ProfileOverrideField,
        value: Binding<String>,
        parent: String,
        placeholder: String
    ) -> some View {
        overrideCardShell(field: field) {
            TextField(placeholder, text: value)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
            parentLine(parent)
        }
    }

    private func nullableStringCard(
        _ field: ProfileOverrideField,
        value: Binding<String>,
        parent: String,
        placeholder: String
    ) -> some View {
        overrideCardShell(field: field) {
            TextField(placeholder, text: value)
                .textFieldStyle(.roundedBorder)
                .font(.system(.callout, design: .monospaced))
            parentLine(parent.isEmpty ? "(none)" : parent)
        }
    }

    private func intCard(
        _ field: ProfileOverrideField,
        value: Binding<Int>,
        parent: Int?,
        range: ClosedRange<Int>,
        unit: String
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 8) {
                Stepper(value: value, in: range) {
                    Text("\(value.wrappedValue) \(unit)")
                        .font(.system(.callout, design: .monospaced))
                }
                .frame(maxWidth: 240)
                Spacer()
            }
            parentLine(parent.map { "\($0) \(unit)" } ?? "(inherited)")
        }
    }

    private func nullableIntCard(
        _ field: ProfileOverrideField,
        value: Binding<Int?>,
        parent: Int?,
        placeholder: String
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 8) {
                TextField(placeholder, value: value, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)
                Button("Clear") { value.wrappedValue = nil }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            parentLine(parent.map { "\($0)" } ?? "Unlimited")
        }
    }

    private func doubleCard(
        _ field: ProfileOverrideField,
        value: Binding<Double>,
        parent: Double?,
        range: ClosedRange<Double>,
        format: String
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 8) {
                Slider(value: value, in: range)
                    .frame(maxWidth: 260)
                Text(String(format: format, value.wrappedValue))
                    .font(.system(.callout, design: .monospaced))
                    .frame(width: 50, alignment: .leading)
                Spacer()
            }
            parentLine(parent.map { String(format: format, $0) } ?? "(inherited)")
        }
    }

    private func nullableDoubleCard(
        _ field: ProfileOverrideField,
        value: Binding<Double?>,
        parent: Double?,
        placeholder: String
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 8) {
                TextField(placeholder, value: value, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)
                Button("Clear") { value.wrappedValue = nil }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            parentLine(parent.map { String(format: "%.2f", $0) } ?? placeholder)
        }
    }

    private func boolCard(
        _ field: ProfileOverrideField,
        value: Binding<Bool>,
        parent: Bool?
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 10) {
                Toggle("", isOn: value)
                    .toggleStyle(.switch)
                    .labelsHidden()
                Text(value.wrappedValue ? "On" : "Off")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            parentLine(parent.map { $0 ? "On" : "Off" } ?? "(inherited)")
        }
    }

    private func enumCard<T: Hashable>(
        _ field: ProfileOverrideField,
        selection: Binding<T>,
        options: [(T, String)],
        parent: String
    ) -> some View {
        overrideCardShell(field: field) {
            Picker("", selection: selection) {
                ForEach(options, id: \.0) { opt in
                    Text(opt.1).tag(opt.0)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(width: 240, alignment: .leading)
            parentLine(parent.isEmpty ? "(inherited)" : parent)
        }
    }

    /// Card for secret-backed fields (PATs). Echoes dot-masked when present;
    /// clearing the field on save sends null.
    private func patCard(
        _ field: ProfileOverrideField,
        value: Binding<String>,
        isSet: Bool
    ) -> some View {
        overrideCardShell(field: field) {
            HStack(spacing: 8) {
                SecureField(isSet ? "(stored — leave blank to keep)" : "Paste token", text: value)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
                if isSet {
                    Label("Stored", systemImage: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Text("Values are encrypted at rest. Leave blank to keep the current value.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    /// Network Policy card — summary line + collapsed details. Uses the
    /// same `networkFields` editor as the classic view.
    private func networkPolicyOverrideCard(field: ProfileOverrideField) -> some View {
        overrideCardShell(field: field) {
            Text(networkPolicySummary)
                .font(.caption)
                .foregroundStyle(.secondary)
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    networkFields
                }
                .padding(.top, 6)
            } label: {
                Text("Edit details")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Action Policy card — collapsed details with the full action policy
    /// editor (enabled groups, overrides, sanitization, quarantine). PIM
    /// is its own top-level card, so we pass `includePim: false` to avoid
    /// rendering it twice.
    private func actionPolicyOverrideCard(field: ProfileOverrideField) -> some View {
        overrideCardShell(field: field) {
            Text(actionPolicySummary)
                .font(.caption)
                .foregroundStyle(.secondary)
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    ActionsSection(
                        profile: $profile,
                        actionCatalog: actionCatalog,
                        includePim: false
                    )
                }
                .padding(.top, 6)
            } label: {
                Text("Edit details")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// PIM Activations card — summary + inline list editor. The editor is
    /// the same component the classic view uses inside ActionsSection.
    private func pimActivationsOverrideCard(field: ProfileOverrideField) -> some View {
        overrideCardShell(field: field) {
            Text("\(profile.pimActivations.count) activation(s)")
                .font(.caption)
                .foregroundStyle(.secondary)
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    PimActivationsEditor(profile: $profile)
                }
                .padding(.top, 6)
            } label: {
                Text("Edit details")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Security Scan card — summary + collapsed details. Detector toggles
    /// (with thresholds) and per-checkpoint policy (provisioning/push) with
    /// scope + per-finding outcome (block/warn/escalate).
    private func securityScanOverrideCard(field: ProfileOverrideField) -> some View {
        overrideCardShell(field: field) {
            Text(securityScanSummary)
                .font(.caption)
                .foregroundStyle(.secondary)
            DisclosureGroup {
                securityScanFields
                    .padding(.top, 6)
            } label: {
                Text("Edit details")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var securityScanSummary: String {
        guard let s = profile.securityScan else { return "Not configured (inherits)" }
        var parts: [String] = []
        if s.secretsDetector.enabled { parts.append("Secrets") }
        if s.piiDetector.enabled { parts.append("PII") }
        if s.injectionDetector.enabled { parts.append("Injection") }
        let detectors = parts.isEmpty ? "no detectors" : parts.joined(separator: " · ")
        let cps = [
            s.provisioning.enabled ? "provision" : nil,
            s.push.enabled ? "push" : nil,
        ].compactMap { $0 }.joined(separator: "+")
        return "\(detectors) @ \(cps.isEmpty ? "no checkpoints" : cps)"
    }

    @ViewBuilder
    private var securityScanFields: some View {
        let binding = Binding<SecurityScanPolicy>(
            get: { profile.securityScan ?? SecurityScanPolicy() },
            set: { profile.securityScan = $0 }
        )
        VStack(alignment: .leading, spacing: 12) {
            Text("Detectors").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            detectorRow(label: "Secrets",
                        config: Binding(get: { binding.wrappedValue.secretsDetector },
                                        set: { binding.wrappedValue.secretsDetector = $0 }),
                        showThreshold: false)
            detectorRow(label: "PII",
                        config: Binding(get: { binding.wrappedValue.piiDetector },
                                        set: { binding.wrappedValue.piiDetector = $0 }),
                        showThreshold: true)
            detectorRow(label: "Prompt Injection",
                        config: Binding(get: { binding.wrappedValue.injectionDetector },
                                        set: { binding.wrappedValue.injectionDetector = $0 }),
                        showThreshold: true)

            Divider().padding(.vertical, 4)

            Text("Checkpoints").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            checkpointRow(label: "Provisioning",
                          policy: Binding(get: { binding.wrappedValue.provisioning },
                                          set: { binding.wrappedValue.provisioning = $0 }))
            checkpointRow(label: "Push",
                          policy: Binding(get: { binding.wrappedValue.push },
                                          set: { binding.wrappedValue.push = $0 }))
        }
    }

    @ViewBuilder
    private func detectorRow(
        label: String,
        config: Binding<DetectorConfig>,
        showThreshold: Bool
    ) -> some View {
        HStack(spacing: 10) {
            Toggle(label, isOn: Binding(
                get: { config.wrappedValue.enabled },
                set: { config.wrappedValue.enabled = $0 }
            ))
            .toggleStyle(.switch)
            .frame(width: 180, alignment: .leading)
            if showThreshold {
                Text("Threshold")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Slider(
                    value: Binding(
                        get: { config.wrappedValue.threshold ?? 0.7 },
                        set: { config.wrappedValue.threshold = $0 }
                    ),
                    in: 0.0...1.0
                )
                .frame(width: 160)
                .disabled(!config.wrappedValue.enabled)
                Text(String(format: "%.2f", config.wrappedValue.threshold ?? 0.7))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(width: 40, alignment: .leading)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func checkpointRow(
        label: String,
        policy: Binding<CheckpointPolicy>
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Toggle(label, isOn: Binding(
                    get: { policy.wrappedValue.enabled },
                    set: { policy.wrappedValue.enabled = $0 }
                ))
                .toggleStyle(.switch)
                .frame(width: 180, alignment: .leading)
                Text("Scope").font(.caption).foregroundStyle(.tertiary)
                Picker("", selection: Binding(
                    get: { policy.wrappedValue.scope },
                    set: { policy.wrappedValue.scope = $0 }
                )) {
                    ForEach(ScanScope.allCases, id: \.self) { s in
                        Text(s.label).tag(s)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 140)
                .disabled(!policy.wrappedValue.enabled)
                Spacer()
            }
            HStack(spacing: 10) {
                outcomePicker(label: "Secret",
                              binding: Binding(get: { policy.wrappedValue.onSecret },
                                               set: { policy.wrappedValue.onSecret = $0 }),
                              enabled: policy.wrappedValue.enabled)
                outcomePicker(label: "PII",
                              binding: Binding(get: { policy.wrappedValue.onPii },
                                               set: { policy.wrappedValue.onPii = $0 }),
                              enabled: policy.wrappedValue.enabled)
                outcomePicker(label: "Injection",
                              binding: Binding(get: { policy.wrappedValue.onInjection },
                                               set: { policy.wrappedValue.onInjection = $0 }),
                              enabled: policy.wrappedValue.enabled)
                Spacer()
            }
            .padding(.leading, 16)
        }
    }

    @ViewBuilder
    private func outcomePicker(
        label: String,
        binding: Binding<ScanOutcome>,
        enabled: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.tertiary)
            Picker("", selection: binding) {
                ForEach(ScanOutcome.allCases, id: \.self) { o in
                    Text(o.label).tag(o)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 200)
            .disabled(!enabled)
        }
    }

    private var networkPolicySummary: String {
        if !profile.networkEnabled { return "Disabled (inherits Docker default)" }
        let hosts = profile.allowedHosts.isEmpty ? "no custom hosts"
            : "\(profile.allowedHosts.count) custom host(s)"
        return "\(profile.networkMode.label) · \(hosts)"
    }

    private var actionPolicySummary: String {
        if !profile.actionPolicyEnabled { return "Disabled" }
        return "\(profile.actionEnabledGroups.count) group(s), \(profile.actionOverrides.count) override(s)"
    }

    /// Composite card for the `pod` object — four related sub-fields.
    private func podCard(_ field: ProfileOverrideField) -> some View {
        overrideCardShell(field: field) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("Agent Mode").font(.caption2).foregroundStyle(.tertiary)
                    Picker("", selection: $profile.pod.agentMode) {
                        ForEach(AgentMode.allCases, id: \.self) { m in
                            Text(m.label).tag(m)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                }
                GridRow {
                    Text("Output").font(.caption2).foregroundStyle(.tertiary)
                    Picker("", selection: $profile.pod.output) {
                        ForEach(OutputTarget.allCases, id: \.self) { o in
                            Text(o.label).tag(o)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 160)
                }
                GridRow {
                    Text("Validate").font(.caption2).foregroundStyle(.tertiary)
                    Toggle("", isOn: $profile.pod.validate)
                        .toggleStyle(.switch).labelsHidden()
                }
                GridRow {
                    Text("Promotable").font(.caption2).foregroundStyle(.tertiary)
                    Toggle("", isOn: $profile.pod.promotable)
                        .toggleStyle(.switch).labelsHidden()
                }
            }
        }
    }

    /// Composite card for escalation — deep-merged merge-special field.
    private func escalationCard(_ field: ProfileOverrideField) -> some View {
        let mode = mergeStrategyDraft["escalation"] ?? .merge
        return overrideCardShell(
            field: field,
            headerTrailing: AnyView(
                Text(mode == .replace ? "replace parent" : "merge with parent")
                    .font(.caption2)
                    .foregroundStyle(mode == .replace ? .orange : .secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        (mode == .replace ? Color.orange : Color.secondary).opacity(0.1),
                        in: Capsule()
                    )
            )
        ) {
            MergeModePicker(
                mode: bindingForMergeMode("escalation"),
                fieldLabel: "Escalation",
                parentName: parentDisplayName
            )
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("Ask human").font(.caption2).foregroundStyle(.tertiary)
                    Toggle("", isOn: $profile.escalationAskHuman).toggleStyle(.switch).labelsHidden()
                }
                GridRow {
                    Text("Ask AI").font(.caption2).foregroundStyle(.tertiary)
                    Toggle("", isOn: $profile.escalationAskAiEnabled).toggleStyle(.switch).labelsHidden()
                }
                GridRow {
                    Text("Ask AI model").font(.caption2).foregroundStyle(.tertiary)
                    TextField("sonnet", text: $profile.escalationAskAiModel)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 180)
                }
                GridRow {
                    Text("Ask AI max calls").font(.caption2).foregroundStyle(.tertiary)
                    Stepper("\(profile.escalationAskAiMaxCalls)", value: $profile.escalationAskAiMaxCalls, in: 0...50)
                        .frame(maxWidth: 160)
                }
                GridRow {
                    Text("Advisor").font(.caption2).foregroundStyle(.tertiary)
                    Toggle("", isOn: $profile.escalationAdvisorEnabled).toggleStyle(.switch).labelsHidden()
                }
                GridRow {
                    Text("Auto pause after").font(.caption2).foregroundStyle(.tertiary)
                    Stepper("\(profile.escalationAutoPauseAfter) escalations", value: $profile.escalationAutoPauseAfter, in: 1...20)
                }
                GridRow {
                    Text("Human resp timeout").font(.caption2).foregroundStyle(.tertiary)
                    Stepper("\(profile.escalationHumanResponseTimeout)s", value: $profile.escalationHumanResponseTimeout, in: 60...86400, step: 60)
                }
            }
        }
    }

    /// Compact helper: the "Parent: <value>" subtitle line under most cards.
    @ViewBuilder
    private func parentLine(_ value: String) -> some View {
        if !value.isEmpty {
            HStack(spacing: 4) {
                Text("Parent:")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Text(value)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }
        }
    }

    // MARK: - Override cards — merge-special arrays

    private func mcpServersOverrideCard(field: ProfileOverrideField) -> some View {
        mergeSpecialArrayCard(
            field: field,
            parentItems: (editorPayload?.parent?.mcpServers ?? []).map { $0.name },
            itemsBinding: $profile.mcpServers,
            itemLabel: { $0.name.isEmpty ? "(unnamed)" : $0.name },
            emptyItem: { InjectedMcpServer() },
            itemEditor: { $item in
                HStack(spacing: 6) {
                    TextField("name", text: $item.name)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 140)
                    TextField("url", text: $item.url)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                }
            }
        )
    }

    private func claudeMdSectionsOverrideCard(field: ProfileOverrideField) -> some View {
        mergeSpecialArrayCard(
            field: field,
            parentItems: (editorPayload?.parent?.claudeMdSections ?? []).map { $0.heading ?? "(untitled)" },
            itemsBinding: $profile.claudeMdSections,
            itemLabel: { $0.heading.isEmpty ? "(untitled)" : $0.heading },
            emptyItem: { InjectedClaudeMdSection() },
            itemEditor: { $item in
                VStack(spacing: 4) {
                    TextField("heading", text: $item.heading)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption))
                    TextField("content", text: $item.content, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(2...4)
                }
            }
        )
    }

    private func skillsOverrideCard(field: ProfileOverrideField) -> some View {
        mergeSpecialArrayCard(
            field: field,
            parentItems: (editorPayload?.parent?.skills ?? []).compactMap { $0.name },
            itemsBinding: $profile.skills,
            itemLabel: { $0.name.isEmpty ? "(unnamed)" : $0.name },
            emptyItem: { InjectedSkill() },
            itemEditor: { $item in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        TextField("name", text: $item.name)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .frame(width: 160)
                        TextField("description", text: Binding(
                            get: { item.description ?? "" },
                            set: { item.description = $0.isEmpty ? nil : $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption))
                    }
                    HStack(spacing: 6) {
                        Picker("", selection: $item.sourceType) {
                            Text("local").tag("local")
                            Text("github").tag("github")
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 140)
                        .labelsHidden()

                        if item.sourceType == "local" {
                            TextField(
                                "absolute or cwd-relative path to .md file",
                                text: $item.localPath
                            )
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        } else {
                            TextField("owner/repo", text: $item.githubRepo)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                                .frame(width: 160)
                            TextField(
                                "path (defaults to <name>.md)",
                                text: $item.githubPath
                            )
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            TextField("ref (default: main)", text: $item.githubRef)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                                .frame(width: 110)
                        }
                    }
                }
            }
        )
    }

    private func privateRegistriesOverrideCard(field: ProfileOverrideField) -> some View {
        mergeSpecialArrayCard(
            field: field,
            parentItems: (editorPayload?.parent?.privateRegistries ?? []).map { "\($0.type): \($0.url)" },
            itemsBinding: $profile.privateRegistries,
            itemLabel: { "\($0.type.rawValue): \($0.url)" },
            emptyItem: { PrivateRegistry(type: .npm, url: "") },
            itemEditor: { $item in
                HStack(spacing: 6) {
                    Picker("", selection: $item.type) {
                        ForEach(RegistryType.allCases, id: \.self) { t in
                            Text(t.rawValue).tag(t)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 80)
                    TextField("url", text: $item.url)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                    TextField("scope", text: Binding(
                        get: { item.scope ?? "" },
                        set: { item.scope = $0.isEmpty ? nil : $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 110)
                }
            }
        )
    }

    private func codeIntelligenceOverrideCard(field: ProfileOverrideField) -> some View {
        let parentCi = editorPayload?.parent?.codeIntelligence
        let parentSerena = parentCi?.serena ?? false
        let parentRoslyn = parentCi?.roslynCodeLens ?? false
        return overrideCardShell(field: field) {
            VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: $profile.codeIntelligenceSerena) {
                    HStack(spacing: 4) {
                        Text("Serena (LSP navigation)")
                        HelpBadge(text: "Installs Serena via pip and injects it as a stdio MCP server.")
                    }
                }
                Toggle(isOn: $profile.codeIntelligenceRoslynCodeLens) {
                    HStack(spacing: 4) {
                        Text("Roslyn CodeLens (C# DI analysis)")
                        HelpBadge(text: "Installs roslyn-codelens-mcp and injects it as a stdio MCP server. Requires a dotnet template.")
                    }
                }
                .disabled(profile.template != .dotnet9 && profile.template != .dotnet10 && profile.template != .dotnet10Go)
            }
            parentLine("Parent: Serena \(parentSerena ? "on" : "off") · Roslyn \(parentRoslyn ? "on" : "off")")
        }
    }

    /// Generic card for merge-special arrays: header badge + mode picker +
    /// read-only parent preview + editable child list. `itemEditor` renders
    /// the inline controls for one item; `emptyItem` produces a blank.
    private func mergeSpecialArrayCard<Item>(
        field: ProfileOverrideField,
        parentItems: [String],
        itemsBinding: Binding<[Item]>,
        itemLabel: @escaping (Item) -> String,
        emptyItem: @escaping () -> Item,
        @ViewBuilder itemEditor: @escaping (Binding<Item>) -> some View
    ) -> some View {
        let mode = mergeStrategyDraft[field.key] ?? .merge
        return overrideCardShell(
            field: field,
            headerTrailing: AnyView(
                Text(mode == .replace ? "replace" : "merge · \(itemsBinding.wrappedValue.count) added")
                    .font(.caption2)
                    .foregroundStyle(mode == .replace ? .orange : .secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        (mode == .replace ? Color.orange : Color.secondary).opacity(0.1),
                        in: Capsule()
                    )
            )
        ) {
            MergeModePicker(
                mode: bindingForMergeMode(field.key),
                fieldLabel: field.label,
                parentName: parentDisplayName
            )
            if mode == .merge, !parentItems.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("From \(parentDisplayName ?? "parent")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    ForEach(parentItems.indices, id: \.self) { i in
                        Text(parentItems[i])
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 1)
                    }
                }
                .padding(.top, 2)
                Divider().padding(.vertical, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Your \(field.label.lowercased())")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                ForEach(itemsBinding.wrappedValue.indices, id: \.self) { i in
                    HStack(spacing: 6) {
                        itemEditor(itemsBinding[i])
                        Button {
                            itemsBinding.wrappedValue.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button {
                    itemsBinding.wrappedValue.append(emptyItem())
                } label: {
                    Label("Add", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    /// Card for a nullable text field where empty = null on save.
    private func nullableTextOverrideCard(
        field: ProfileOverrideField,
        value: Binding<String>,
        parentValue: String
    ) -> some View {
        overrideCardShell(field: field) {
            TextEditor(text: value)
                .font(.system(.callout))
                .frame(height: 90)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(.quaternary, lineWidth: 1)
                )
            if !parentValue.isEmpty {
                DisclosureGroup("Parent value (\(parentValue.count) chars)") {
                    ScrollView {
                        Text(parentValue)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(6)
                    }
                    .frame(maxHeight: 120)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
        }
    }

    /// Card for smokePages — the canonical merge-special flow.
    private func buildEnvOverrideCard(field: ProfileOverrideField) -> some View {
        let parentEnv = editorPayload?.parent?.buildEnv ?? [:]
        return overrideCardShell(field: field) {
            if !parentEnv.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("From \(parentDisplayName ?? "parent")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    ForEach(parentEnv.sorted(by: { $0.key < $1.key }), id: \.key) { entry in
                        Text("\(entry.key)=\(entry.value)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 1)
                    }
                }
                .padding(.top, 2)
                Divider().padding(.vertical, 2)
                Text("Your overrides (replaces parent values entirely)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            BuildEnvEditor(env: $profile.buildEnv)
        }
    }

    private func deploymentOverrideCard(field: ProfileOverrideField) -> some View {
        let parentDeployment = editorPayload?.parent?.deployment
        let parentEnabled = parentDeployment?.enabled ?? false
        let parentEnv = parentDeployment?.env ?? [:]
        let parentScripts = parentDeployment?.allowedScripts ?? []
        return overrideCardShell(field: field) {
            if parentEnabled || !parentEnv.isEmpty || !parentScripts.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("From \(parentDisplayName ?? "parent")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(parentEnabled ? "enabled" : "disabled")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                    ForEach(parentEnv.sorted(by: { $0.key < $1.key }), id: \.key) { entry in
                        Text("\(entry.key)=\(entry.value)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(parentScripts, id: \.self) { glob in
                        Text("allow: \(glob)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 2)
                Divider().padding(.vertical, 2)
                Text("Your overrides (replaces parent deployment block entirely)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Toggle(isOn: $profile.deploymentEnabled) {
                Text(profile.deploymentEnabled ? "Deployment enabled" : "Deployment disabled")
                    .font(.callout)
            }
            .toggleStyle(.switch)
            Text("Environment Variables")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
            DeploymentEnvEditor(env: $profile.deploymentEnv)
            Text("Allowed Scripts")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
            DeploymentAllowedScriptsEditor(scripts: $profile.deploymentAllowedScripts)
        }
    }

    private func smokePagesOverrideCard(field: ProfileOverrideField) -> some View {
        let mode = mergeStrategyDraft["smokePages"] ?? .merge
        let parentPages = editorPayload?.parent?.smokePages ?? []
        return overrideCardShell(
            field: field,
            headerTrailing: AnyView(
                Text(mode == .replace ? "replace" : "merge · \(profile.smokePages.count) added")
                    .font(.caption2)
                    .foregroundStyle(mode == .replace ? .orange : .secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        (mode == .replace ? Color.orange : Color.secondary).opacity(0.1),
                        in: Capsule()
                    )
            )
        ) {
            MergeModePicker(
                mode: bindingForMergeMode("smokePages"),
                fieldLabel: "Smoke pages",
                parentName: parentDisplayName
            )
            if mode == .merge, !parentPages.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("From \(parentDisplayName ?? "parent")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    ForEach(parentPages.indices, id: \.self) { i in
                        Text(parentPages[i].path)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 1)
                    }
                }
                .padding(.top, 2)
                Divider().padding(.vertical, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Your pages")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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
    }

    /// Shared chrome around every override card: label, remove button, border.
    @ViewBuilder
    private func overrideCardShell<Content: View>(
        field: ProfileOverrideField,
        headerTrailing: AnyView? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(field.label)
                    .font(.callout.weight(.semibold))
                Text(field.section.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                if let headerTrailing {
                    headerTrailing
                }
                Spacer()
                Button {
                    // Remove override → back to inherited
                    inheritedFields.insert(field.key)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.borderless)
                .help("Remove override — inherit from \(parentDisplayName ?? "parent")")
            }
            if !field.help.isEmpty {
                Text(field.help)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            content()
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.accentColor.opacity(0.25), lineWidth: 1)
        )
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

    private func patRow(
        _ label: String,
        value: Binding<String?>,
        isSet: Bool,
        isInherited: Bool = false,
        help: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HelpBadge(text: help)
                Spacer()
                if (value.wrappedValue ?? "").isEmpty {
                    if isSet {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text(isInherited ? "Inherited ✓" : "Configured")
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    } else if isInherited {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                            Text("Inherited — not configured in parent")
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
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
    /// When false, the PIM block is not rendered — used by the overrides
    /// view which surfaces PIM as its own top-level card.
    var includePim: Bool = true

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

            if includePim {
                Divider().padding(.vertical, 4)
                PimActivationsEditor(profile: $profile)
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

// MARK: - PIM activations editor (header + list + add button)

struct PimActivationsEditor: View {
    @Binding var profile: Profile

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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


// MARK: - BuildEnv editor

/// Inline key/value editor over a `[String: String]` binding. Holds a
/// stable-id row list internally so editing a key doesn't re-key the
/// dictionary mid-keystroke and lose focus. Empty keys are skipped when
/// syncing back so users can stage a new entry without polluting the dict.
private struct BuildEnvEditor: View {
    @Binding var env: [String: String]
    @State private var rows: [Row] = []

    private struct Row: Identifiable {
        let id: UUID = UUID()
        var key: String
        var value: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach($rows) { $row in
                HStack(spacing: 6) {
                    TextField("KEY", text: $row.key)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .onChange(of: row.key) { _, _ in sync() }
                    Text("=").foregroundStyle(.secondary)
                    TextField("value", text: $row.value)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .onChange(of: row.value) { _, _ in sync() }
                    Button {
                        rows.removeAll { $0.id == row.id }
                        sync()
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundStyle(.red.opacity(0.6))
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button {
                rows.append(Row(key: "", value: ""))
            } label: {
                Label("Add variable", systemImage: "plus")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
        }
        .onAppear { populate() }
    }

    private func populate() {
        rows = env.sorted(by: { $0.key < $1.key })
            .map { Row(key: $0.key, value: $0.value) }
    }

    private func sync() {
        var d: [String: String] = [:]
        for r in rows where !r.key.isEmpty {
            d[r.key] = r.value
        }
        if d != env { env = d }
    }
}

private struct DeploymentEnvEditor: View {
    @Binding var env: [String: String]
    @State private var rows: [Row] = []

    private struct Row: Identifiable {
        let id: UUID = UUID()
        var key: String
        var value: String
    }

    private static let daemonPrefix = "$DAEMON:"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach($rows) { $row in
                HStack(spacing: 6) {
                    TextField("KEY", text: $row.key)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .onChange(of: row.key) { _, _ in sync() }
                    Text("=").foregroundStyle(.secondary)
                    TextField("value or $DAEMON:VAR", text: $row.value)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .onChange(of: row.value) { _, _ in sync() }
                    if row.value.hasPrefix(Self.daemonPrefix) {
                        Image(systemName: "key.fill")
                            .foregroundStyle(.purple.opacity(0.8))
                            .help("Resolved from the daemon's environment at execution time. The container never sees this value in its persistent env.")
                    }
                    Button {
                        rows.removeAll { $0.id == row.id }
                        sync()
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundStyle(.red.opacity(0.6))
                    }
                    .buttonStyle(.borderless)
                }
            }
            HStack(spacing: 8) {
                Button {
                    rows.append(Row(key: "", value: ""))
                } label: {
                    Label("Add variable", systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                Button {
                    rows.append(Row(key: "", value: Self.daemonPrefix))
                } label: {
                    Label("Add daemon-resolved secret", systemImage: "key.fill")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        }
        .onAppear { populate() }
    }

    private func populate() {
        rows = env.sorted(by: { $0.key < $1.key })
            .map { Row(key: $0.key, value: $0.value) }
    }

    private func sync() {
        var d: [String: String] = [:]
        for r in rows where !r.key.isEmpty {
            d[r.key] = r.value
        }
        if d != env { env = d }
    }
}

private struct DeploymentAllowedScriptsEditor: View {
    @Binding var scripts: [String]
    @State private var rows: [Row] = []

    private struct Row: Identifiable {
        let id: UUID = UUID()
        var glob: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if rows.isEmpty {
                Text("No allowlist — any script the agent invokes will be permitted (still gated by human approval).")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            ForEach($rows) { $row in
                HStack(spacing: 6) {
                    TextField("scripts/deploy-*.sh", text: $row.glob)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .onChange(of: row.glob) { _, _ in sync() }
                    Button {
                        rows.removeAll { $0.id == row.id }
                        sync()
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundStyle(.red.opacity(0.6))
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button {
                rows.append(Row(glob: ""))
            } label: {
                Label("Add glob", systemImage: "plus")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
        }
        .onAppear { populate() }
    }

    private func populate() {
        rows = scripts.map { Row(glob: $0) }
    }

    private func sync() {
        let next = rows.map(\.glob).filter { !$0.isEmpty }
        if next != scripts { scripts = next }
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
