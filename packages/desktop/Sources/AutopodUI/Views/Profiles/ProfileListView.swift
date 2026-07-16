import AutopodClient
import SwiftUI

private enum ProfileSegment: String, CaseIterable, Identifiable {
    case all, bases, overrides
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "All"
        case .bases: return "Bases"
        case .overrides: return "Overrides"
        }
    }
}

private struct ProfileRow: Identifiable {
    let profile: Profile
    let isInlineChild: Bool
    let derivedCount: Int
    var id: String { isInlineChild ? "child:\(profile.name)" : profile.name }
}

/// Profile list — shows all profiles with quick stats, click to edit.
public struct ProfileListView: View {
    public let profiles: [Profile]
    public let actionCatalog: [ActionCatalogItem]
    public let builtinSkills: [BuiltinSkillEntry]
    public var onSave: ((Profile) async throws -> Void)?
    public var onCreate: ((Profile) async throws -> Void)?
    public var onAuthenticate: ProfileAuthHandler?
    public var onLoadProviderAccounts: ProviderAccountsLoadHandler?
    public var onLoadEditor: ((String) async throws -> ProfileEditorResponse)?
    public var onSaveWithInheritance: (
        (Profile, Set<String>, Set<String>, [String: MergeMode]) async throws -> Void
    )?
    public var onCreateWithInheritance: (
        (Profile, Set<String>, [String: MergeMode]) async throws -> Void
    )?
    public var onDelete: ((String) async throws -> Void)?
    @Binding private var profileToOpen: String?
    public init(profiles: [Profile], actionCatalog: [ActionCatalogItem] = [],
                builtinSkills: [BuiltinSkillEntry] = [],
                onSave: ((Profile) async throws -> Void)? = nil, onCreate: ((Profile) async throws -> Void)? = nil,
                onAuthenticate: ProfileAuthHandler? = nil,
                onLoadProviderAccounts: ProviderAccountsLoadHandler? = nil,
                onLoadEditor: ((String) async throws -> ProfileEditorResponse)? = nil,
                onSaveWithInheritance: (
                    (Profile, Set<String>, Set<String>, [String: MergeMode]) async throws -> Void
                )? = nil,
                onCreateWithInheritance: (
                    (Profile, Set<String>, [String: MergeMode]) async throws -> Void
                )? = nil,
                onDelete: ((String) async throws -> Void)? = nil,
                profileToOpen: Binding<String?> = .constant(nil)) {
        self.profiles = profiles; self.actionCatalog = actionCatalog
        self.builtinSkills = builtinSkills
        self.onSave = onSave; self.onCreate = onCreate
        self.onAuthenticate = onAuthenticate
        self.onLoadProviderAccounts = onLoadProviderAccounts
        self.onLoadEditor = onLoadEditor
        self.onSaveWithInheritance = onSaveWithInheritance
        self.onCreateWithInheritance = onCreateWithInheritance
        self.onDelete = onDelete
        self._profileToOpen = profileToOpen
    }

    @State private var selectedProfile: Profile?
    @State private var showCreateSheet = false
    /// When the kind picker returns "Derived", this holds the parent name
    /// and the editor sheet opens with `extends` pre-set.
    @State private var creatingDerivedFrom: String?
    /// When the kind picker returns "Base", we open the classic editor.
    @State private var creatingBase = false

    @State private var searchText: String = ""
    @State private var segment: ProfileSegment = .all
    @State private var expandedBases: Set<String> = []
    @State private var highlightedName: String?

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            toolbar
            Divider()
            scrollList
        }
        .sheet(item: $selectedProfile) { profile in
            ProfileEditorView(
                profile: profile,
                isNew: false,
                actionCatalog: actionCatalog,
                builtinSkills: builtinSkills,
                onSave: onSave,
                onAuthenticate: onAuthenticate,
                onLoadProviderAccounts: onLoadProviderAccounts,
                onLoadEditor: onLoadEditor,
                onSaveWithInheritance: onSaveWithInheritance,
                onDelete: onDelete
            )
        }
        .sheet(isPresented: $showCreateSheet) {
            NewProfileKindSheet(
                availableParents: profiles.map(\.name).sorted(),
                onEmpty: {
                    DispatchQueue.main.async { creatingBase = true }
                },
                onDerived: { parent in
                    DispatchQueue.main.async { creatingDerivedFrom = parent }
                }
            )
        }
        .sheet(isPresented: $creatingBase) {
            ProfileEditorView(
                profile: Profile(name: "", repoUrl: ""),
                isNew: true,
                actionCatalog: actionCatalog,
                builtinSkills: builtinSkills,
                onSave: onCreate,
                onLoadProviderAccounts: onLoadProviderAccounts
            )
        }
        .sheet(item: $creatingDerivedFrom) { parent in
            ProfileEditorView(
                profile: Profile(
                    name: "",
                    repoUrl: "",
                    extendsProfile: parent
                ),
                isNew: true,
                actionCatalog: actionCatalog,
                builtinSkills: builtinSkills,
                onSave: onCreate,
                onLoadProviderAccounts: onLoadProviderAccounts,
                onLoadEditor: onLoadEditor,
                onSaveWithInheritance: onSaveWithInheritance,
                onCreateWithInheritance: onCreateWithInheritance
            )
        }
        .onAppear { openDeepLinkedProfileIfNeeded() }
        .onChange(of: profileToOpen) { _, _ in openDeepLinkedProfileIfNeeded() }
        .onChange(of: profileNamesSignature) { _, _ in openDeepLinkedProfileIfNeeded() }
    }

    // MARK: - Sections

    private var header: some View {
        HStack {
            Text("Profiles").font(.headline)
            countBadge(profiles.count, color: .blue)
            Spacer()
            Button {
                showCreateSheet = true
            } label: {
                Label("New Profile", systemImage: "plus")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(16)
    }

    private var toolbar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("Search name, repo, or parent…", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.callout)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
            )

            Picker("Filter", selection: $segment) {
                ForEach(ProfileSegment.allCases) { seg in
                    Text("\(seg.label) \(count(for: seg))").tag(seg)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var scrollList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                let rows = displayedRows
                LazyVStack(spacing: 10) {
                    if rows.isEmpty {
                        emptyState
                    } else {
                        ForEach(rows) { row in
                            ProfileCard(
                                profile: row.profile,
                                derivedCount: row.derivedCount,
                                isExpanded: expandedBases.contains(row.profile.name),
                                isInlineChild: row.isInlineChild,
                                isHighlighted: highlightedName == row.profile.name,
                                onExpandToggle: row.derivedCount > 0 ? {
                                    handleExpandTap(for: row.profile.name)
                                } : nil,
                                onExtendsTap: parentJumpHandler(for: row.profile, proxy: proxy)
                            )
                            .id(row.profile.name)
                            .onTapGesture {
                                selectedProfile = row.profile
                            }
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.title2)
                .foregroundStyle(.tertiary)
            Text(emptyMessage)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var emptyMessage: String {
        if !searchText.isEmpty {
            return "No matches for \"\(searchText)\""
        }
        switch segment {
        case .bases: return "No base profiles yet"
        case .overrides: return "No override profiles yet"
        case .all: return "No profiles yet"
        }
    }

    // MARK: - Helpers

    private func countBadge(_ n: Int, color: Color) -> some View {
        Text("\(n)")
            .font(.system(.caption2).weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.1))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func count(for seg: ProfileSegment) -> Int {
        switch seg {
        case .all: return profiles.count
        case .bases: return profiles.filter { $0.extendsProfile == nil }.count
        case .overrides: return profiles.filter { $0.extendsProfile != nil }.count
        }
    }

    private var derivedByParent: [String: [Profile]] {
        Dictionary(grouping: profiles.filter { $0.extendsProfile != nil }) {
            $0.extendsProfile ?? ""
        }
    }

    private var baseNames: Set<String> {
        Set(profiles.filter { $0.extendsProfile == nil }.map(\.name))
    }

    private var profileNamesSignature: [String] {
        profiles.map(\.name).sorted()
    }

    private var displayedRows: [ProfileRow] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        func match(_ p: Profile) -> Bool {
            guard !q.isEmpty else { return true }
            if p.name.lowercased().contains(q) { return true }
            if p.repoUrl.lowercased().contains(q) { return true }
            if let parent = p.extendsProfile, parent.lowercased().contains(q) { return true }
            return false
        }

        switch segment {
        case .bases:
            return profiles
                .filter { $0.extendsProfile == nil }
                .filter(match)
                .sorted { $0.name < $1.name }
                .map { ProfileRow(
                    profile: $0,
                    isInlineChild: false,
                    derivedCount: derivedByParent[$0.name]?.count ?? 0
                ) }

        case .overrides:
            return profiles
                .filter { $0.extendsProfile != nil }
                .filter(match)
                .sorted { $0.name < $1.name }
                .map { ProfileRow(profile: $0, isInlineChild: false, derivedCount: 0) }

        case .all:
            var rows: [ProfileRow] = []
            let bases = profiles.filter { $0.extendsProfile == nil }.sorted { $0.name < $1.name }
            let knownBases = baseNames
            for base in bases {
                let kids = (derivedByParent[base.name] ?? []).sorted { $0.name < $1.name }
                let baseHit = match(base)
                let kidHits = kids.filter(match)
                if !q.isEmpty, !baseHit, kidHits.isEmpty { continue }
                rows.append(ProfileRow(
                    profile: base,
                    isInlineChild: false,
                    derivedCount: kids.count
                ))
                let isExpanded = expandedBases.contains(base.name)
                let showKids = !q.isEmpty ? !kidHits.isEmpty : isExpanded
                if showKids {
                    let visibleKids = !q.isEmpty ? kidHits : kids
                    for kid in visibleKids {
                        rows.append(ProfileRow(profile: kid, isInlineChild: true, derivedCount: 0))
                    }
                }
            }
            // Orphan derived profiles (parent missing) — show flat at the end so they're not lost.
            let orphans = profiles
                .filter { $0.extendsProfile != nil
                    && !knownBases.contains($0.extendsProfile ?? "") }
                .filter(match)
                .sorted { $0.name < $1.name }
            for orphan in orphans {
                rows.append(ProfileRow(profile: orphan, isInlineChild: false, derivedCount: 0))
            }
            return rows
        }
    }

    private func parentJumpHandler(for profile: Profile, proxy: ScrollViewProxy) -> ((String) -> Void)? {
        guard let parent = profile.extendsProfile, baseNames.contains(parent) else { return nil }
        return { name in jumpToParent(name, proxy: proxy) }
    }

    private func handleExpandTap(for name: String) {
        if segment == .bases {
            // In Bases-only view there's nothing to expand into — promote to All so children appear.
            withAnimation(.easeOut(duration: 0.15)) {
                segment = .all
                expandedBases.insert(name)
            }
            return
        }
        toggleExpand(name)
    }

    private func toggleExpand(_ name: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expandedBases.contains(name) {
                expandedBases.remove(name)
            } else {
                expandedBases.insert(name)
            }
        }
    }

    private func jumpToParent(_ parentName: String, proxy: ScrollViewProxy) {
        searchText = ""
        withAnimation(.easeOut(duration: 0.15)) {
            segment = .all
            expandedBases.insert(parentName)
        }
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.25)) {
                proxy.scrollTo(parentName, anchor: .center)
            }
            highlightedName = parentName
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            if highlightedName == parentName { highlightedName = nil }
        }
    }

    private func openDeepLinkedProfileIfNeeded() {
        guard let name = profileToOpen,
              let profile = Self.profile(named: name, in: profiles) else { return }
        searchText = ""
        segment = .all
        if let parent = profile.extendsProfile, !parent.isEmpty {
            expandedBases.insert(parent)
        }
        highlightedName = profile.name
        selectedProfile = profile
        profileToOpen = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if highlightedName == profile.name {
                highlightedName = nil
            }
        }
    }

    static func profile(named name: String, in profiles: [Profile]) -> Profile? {
        profiles.first { $0.name == name }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

// MARK: - Profile card

struct ProfileCard: View {
    let profile: Profile
    var derivedCount: Int = 0
    var isExpanded: Bool = false
    var isInlineChild: Bool = false
    var isHighlighted: Bool = false
    var onExpandToggle: (() -> Void)?
    var onExtendsTap: ((String) -> Void)?

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 0) {
            if isInlineChild {
                indentRail
            }
            cardContent
        }
    }

    private var indentRail: some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.leading, 14)
            .padding(.trailing, 12)
    }

    private var cardContent: some View {
        HStack(spacing: 14) {
            templateIcon
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(profile.name)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                    Text(profile.template.label)
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.08))
                        .foregroundStyle(.blue)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    if profile.executionTarget == .sandbox {
                        Text("Sandbox")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.purple.opacity(0.08))
                            .foregroundStyle(.purple)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    if derivedCount > 0, let onExpandToggle {
                        Button(action: onExpandToggle) {
                            HStack(spacing: 3) {
                                Text("+\(derivedCount)")
                                    .font(.system(.caption2).weight(.semibold))
                                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 8, weight: .semibold))
                            }
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.green.opacity(0.12))
                            .foregroundStyle(.green)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        .buttonStyle(.plain)
                        .help(isExpanded
                            ? "Hide overrides"
                            : "Show \(derivedCount) override\(derivedCount == 1 ? "" : "s")")
                    }
                }
                Text(profile.repoUrl)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let parent = profile.extendsProfile {
                    extendsLabel(parent: parent)
                }
            }

            Spacer()

            HStack(spacing: 12) {
                if profile.networkEnabled {
                    statBadge(icon: "shield.checkered", label: profile.networkMode.label, color: .green)
                }
                if profile.hasAdoPat || profile.hasRegistryPat {
                    statBadge(icon: credentialBadgeIcon, label: credentialBadgeLabel, color: credentialBadgeColor)
                }
                if profile.mcpServerCount > 0 {
                    statBadge(icon: "server.rack", label: "\(profile.mcpServerCount)", color: .purple)
                }
                if profile.skillCount > 0 {
                    statBadge(icon: "bolt.fill", label: "\(profile.skillCount)", color: .indigo)
                }
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(isHovered ? 0.08 : 0.03),
                        radius: isHovered ? 6 : 3, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(strokeColor, lineWidth: strokeWidth)
        )
        .scaleEffect(isHovered ? 1.005 : 1.0)
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .animation(.easeOut(duration: 0.2), value: isHighlighted)
        .onHover { isHovered = $0 }
    }

    @ViewBuilder
    private func extendsLabel(parent: String) -> some View {
        if let onExtendsTap {
            Button {
                onExtendsTap(parent)
            } label: {
                Label("extends \(parent)", systemImage: "arrow.turn.down.right")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .help("Jump to \(parent)")
        } else {
            Label("extends \(parent)", systemImage: "arrow.turn.down.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var strokeColor: Color {
        isHighlighted ? Color.accentColor : Color(nsColor: .separatorColor)
    }

    private var strokeWidth: CGFloat {
        isHighlighted ? 2 : 0.5
    }

    private var credentialBadgeIcon: String {
        switch nonGitHubPatExpiryStatus {
        case .some(.expired(_)):
            "key.slash.fill"
        case .some(.soon(_)):
            "key.fill"
        default:
            "key.fill"
        }
    }

    private var credentialBadgeLabel: String {
        switch nonGitHubPatExpiryStatus {
        case .some(.expired(_)):
            "Expired"
        case .some(.soon(_)):
            "Expiring"
        default:
            profile.prProvider.label
        }
    }

    private var credentialBadgeColor: Color {
        switch nonGitHubPatExpiryStatus {
        case .some(.expired(_)):
            .red
        case .some(.soon(_)):
            .orange
        default:
            .orange
        }
    }

    private var nonGitHubPatExpiryStatus: PatExpiryStatus? {
        let statuses = [
            profile.hasAdoPat ? profile.adoPatExpiryStatus : nil,
            profile.hasRegistryPat ? profile.registryPatExpiryStatus : nil,
        ].compactMap { $0 }
        if let expired = statuses.first(where: { if case .expired = $0 { true } else { false } }) {
            return expired
        }
        return statuses.first(where: { if case .soon = $0 { true } else { false } }) ?? statuses.first
    }

    private var templateIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.blue.opacity(0.08))
                .frame(width: 36, height: 36)
            Image(systemName: templateSystemImage)
                .font(.system(size: 16))
                .foregroundStyle(.blue)
        }
    }

    private var templateSystemImage: String {
        switch profile.template {
        case .node22, .node22Pw:             "n.circle"
        case .dotnet9, .dotnet10, .dotnet10Go: "d.circle"
        case .python312, .pythonNode, .pythonNodePg: "p.circle"
        case .go124, .go124Pw:               "g.circle"
        case .custom:                        "gearshape"
        }
    }

    private func statBadge(icon: String, label: String, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(label)
                .font(.caption2)
        }
        .foregroundStyle(color)
    }
}

#Preview("Profile list") {
    ProfileListView(profiles: MockProfiles.all)
        .frame(width: 700, height: 500)
}
