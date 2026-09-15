import AutopodClient
import SwiftUI

private enum ConfigurationLibraryPage: String {
  case profiles, buildingBlocks, repositories, watchers, deployments
}

private enum ProfileLibrarySort: String, CaseIterable, Identifiable {
  case recentlyEdited, name, repository, mostUsed
  var id: String { rawValue }
  var label: String {
    switch self {
    case .recentlyEdited: "Recently edited"
    case .name: "Name"
    case .repository: "Repository"
    case .mostUsed: "Most used"
    }
  }
}

private extension ConfigurationKind {
  var editorLabel: String {
    switch self {
    case .repository: "Repository"
    case .environment: "Environment"
    case .ai: "AI setup"
    case .workflow: "Workflow"
    case .githubAccess: "GitHub access"
    case .toolPack: "Tool pack"
    case .profile: "Profile"
    }
  }
}

public struct ConfigurationLibraryView: View {
  public var actions: LaunchConfigurationActions
  @State private var kind: ConfigurationKind = .profile
  @State private var page: ConfigurationLibraryPage = .profiles
  @State private var editor: EditorTarget?
  @State private var search = ""
  @State private var selectedRepositoryID: String?
  @State private var profileSort: ProfileLibrarySort = .recentlyEdited
  @State private var error: String?
  private struct EditorTarget: Identifiable {
    let id = UUID()
    let kind: ConfigurationKind
    let document: ConfigurationDocument?
    let draft: ConfigurationDocument?
  }
  public init(actions: LaunchConfigurationActions, initialKind: ConfigurationKind = .profile) {
    self.actions = actions
    self._kind = State(initialValue: initialKind)
    let initialPage: ConfigurationLibraryPage = switch initialKind {
    case .profile: .profiles
    case .repository: .repositories
    default: .buildingBlocks
    }
    self._page = State(initialValue: initialPage)
  }
  public var body: some View {
    VStack(spacing: 0) {
      libraryNavigation
      Divider()
      switch page {
      case .profiles: profileLibrary
      case .buildingBlocks: buildingBlockLibrary
      case .repositories: repositoryLibrary
      case .watchers: WatcherLibraryView(actions: actions)
      case .deployments: DeploymentLibraryView(actions: actions)
      }
    }
    .sheet(item: $editor) { target in
      ConfigurationEditorSheet(
        kind: target.kind,
        document: target.document,
        draft: target.draft,
        actions: actions
      )
    }
    .onChange(of: page) { _, _ in search = "" }
  }

  private var libraryNavigation: some View {
    HStack(spacing: 8) {
      HStack(spacing: 2) {
        primaryNavigationButton(
          "Profiles",
          count: actions.list(.profile).count,
          target: .profiles
        )
        primaryNavigationButton(
          "Building blocks",
          count: buildingBlockCount,
          target: .buildingBlocks
        )
      }
      .padding(3)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      Spacer()
      Menu {
        Button("Repositories", systemImage: "shippingbox") { page = .repositories }
        Divider()
        Button("Issue watchers", systemImage: "eye") { page = .watchers }
        Button("Deployments", systemImage: "externaldrive.badge.timemachine") { page = .deployments }
      } label: {
        Label(secondaryPageLabel, systemImage: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      Button("Refresh", systemImage: "arrow.clockwise") { Task { await actions.reload() } }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .help("Refresh configuration")
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.35))
  }

  private func primaryNavigationButton(
    _ title: String,
    count: Int,
    target: ConfigurationLibraryPage
  ) -> some View {
    Button { page = target } label: {
      HStack(spacing: 7) {
        Text(title)
        Text("\(count)").font(.caption2).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12)
      .frame(height: 28)
      .background(
        RoundedRectangle(cornerRadius: 6)
          .fill(page == target ? Color(nsColor: .selectedControlColor) : .clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(page == target ? .isSelected : [])
  }

  private var secondaryPageLabel: String {
    switch page {
    case .repositories: "Repositories"
    case .watchers: "Issue watchers"
    case .deployments: "Deployments"
    default: "More"
    }
  }

  private var profileLibrary: some View {
    VStack(alignment: .leading, spacing: 16) {
      libraryHeader(
        title: "Profiles",
        subtitle: "Complete, launch-ready configurations for your repositories.",
        actionTitle: "New profile",
        kind: .profile
      )
      HStack(spacing: 10) {
        configurationSearch(placeholder: "Search profiles")
        RepositoryFilterMenu(
          repositories: actions.list(.repository),
          selectedID: $selectedRepositoryID
        )
        Picker("Sort profiles", selection: $profileSort) {
          ForEach(ProfileLibrarySort.allCases) { Text($0.label).tag($0) }
        }
        .labelsHidden()
        .frame(width: 155)
      }
      errorBanner
      ScrollView {
        LazyVGrid(
          columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)],
          alignment: .leading,
          spacing: 14
        ) {
          if filteredProfiles.isEmpty {
            ContentUnavailableView(
              "No profiles found",
              systemImage: "person.crop.rectangle.stack",
              description: Text("Try another search or repository filter.")
            )
            .frame(maxWidth: .infinity, minHeight: 260)
            .gridCellColumns(2)
          } else {
            ForEach(filteredProfiles) { profile in
              ProfileLibraryCard(
                profile: profile,
                repositoryLabel: repositoryLabel(for: profile),
                rows: profileRows(for: profile),
                usageCount: usageCount(profile.id),
                onEdit: { edit(profile) },
                onDuplicate: { duplicate(profile) },
                onArchive: { archive(profile) }
              )
            }
          }
        }
        .padding(.bottom, 4)
      }
    }
    .padding(20)
  }

  private var buildingBlockLibrary: some View {
    VStack(alignment: .leading, spacing: 16) {
      libraryHeader(
        title: "Building blocks",
        subtitle: "Reusable pieces shared by profiles. Editing one updates future launches.",
        actionTitle: "New building block",
        kind: kind
      )
      errorBanner
      HStack(alignment: .top, spacing: 0) {
        VStack(spacing: 4) {
          ForEach(buildingBlockKinds) { item in
            Button {
              kind = item
              search = ""
            } label: {
              HStack(spacing: 10) {
                Image(systemName: icon(for: item)).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                  Text(item.label).font(.callout.weight(.medium))
                  Text(kindDescription(item)).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(actions.list(item).count)").font(.caption2).foregroundStyle(.secondary)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 9)
              .background(
                RoundedRectangle(cornerRadius: 8)
                  .fill(kind == item ? Color.accentColor.opacity(0.16) : .clear)
              )
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
          Spacer()
        }
        .padding(10)
        .frame(width: 230)
        .frame(minHeight: 470)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
        Divider()
        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
              Text(kind.label).font(.title3.weight(.semibold))
              Text(kindLongDescription(kind)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            configurationSearch(placeholder: "Search \(kind.label.lowercased())")
              .frame(width: 245)
          }
          ScrollView {
            LazyVStack(spacing: 9) {
              if filteredDocuments(kind).isEmpty {
                ContentUnavailableView.search(text: search)
                  .frame(maxWidth: .infinity, minHeight: 280)
              } else {
                ForEach(filteredDocuments(kind)) { document in
                  BuildingBlockRow(
                    document: document,
                    summary: buildingBlockSummary(document),
                    usageCount: usageCount(document.id),
                    onEdit: { edit(document) },
                    onDuplicate: { duplicate(document) },
                    onArchive: { archive(document) }
                  )
                }
              }
            }
          }
        }
        .padding(16)
      }
      .background(.background, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }
    .padding(20)
  }

  private var repositoryLibrary: some View {
    VStack(alignment: .leading, spacing: 16) {
      libraryHeader(
        title: "Repositories",
        subtitle: "Repository identities, project setups, and their default profiles.",
        actionTitle: "New repository",
        kind: .repository
      )
      configurationSearch(placeholder: "Search repositories")
      errorBanner
      ScrollView {
        LazyVStack(spacing: 9) {
          ForEach(filteredDocuments(.repository)) { document in
            RepositoryLibraryRow(
              document: document,
              defaultProfile: referencedTitle(document.payload["usualProfileId"]?.string),
              usageCount: usageCount(document.id),
              onEdit: { edit(document) },
              onDuplicate: { duplicate(document) },
              onArchive: { archive(document) }
            )
          }
        }
      }
    }
    .padding(20)
  }

  private func libraryHeader(
    title: String,
    subtitle: String,
    actionTitle: String,
    kind: ConfigurationKind
  ) -> some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.title2.weight(.semibold))
        Text(subtitle).font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      Button(actionTitle, systemImage: "plus") { create(kind) }
        .buttonStyle(.borderedProminent)
        .controlSize(.regular)
    }
  }

  private func configurationSearch(placeholder: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.caption).foregroundStyle(.secondary)
      TextField(placeholder, text: $search).textFieldStyle(.plain)
      if !search.isEmpty {
        Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
          .buttonStyle(.plain).foregroundStyle(.tertiary)
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 34)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.quaternary))
  }

  @ViewBuilder private var errorBanner: some View {
    if let message = error ?? actions.loadError {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .font(.caption).foregroundStyle(.red).textSelection(.enabled)
    }
  }

  private var buildingBlockKinds: [ConfigurationKind] {
    [.environment, .ai, .workflow, .githubAccess, .toolPack]
  }
  private var buildingBlockCount: Int {
    buildingBlockKinds.reduce(0) { $0 + actions.list($1).count }
  }

  private var filteredProfiles: [ConfigurationDocument] {
    var profiles = actions.list(.profile).filter { profile in
      let repositories = repositories(for: profile)
      let matchesRepository = selectedRepositoryID == nil
        || repositories.contains(where: { $0.id == selectedRepositoryID })
      let searchable = ([profile.name] + repositories.map(\.libraryTitle)
        + profileRows(for: profile).map(\.value)).joined(separator: " ")
      return matchesRepository && (search.isEmpty || searchable.localizedCaseInsensitiveContains(search))
    }
    switch profileSort {
    case .recentlyEdited: profiles.sort { $0.updatedAt > $1.updatedAt }
    case .name: profiles.sort { $0.libraryTitle.localizedStandardCompare($1.libraryTitle) == .orderedAscending }
    case .repository: profiles.sort { repositoryLabel(for: $0).localizedStandardCompare(repositoryLabel(for: $1)) == .orderedAscending }
    case .mostUsed: profiles.sort { usageCount($0.id) > usageCount($1.id) }
    }
    return profiles
  }

  private func filteredDocuments(_ targetKind: ConfigurationKind) -> [ConfigurationDocument] {
    actions.list(targetKind).filter {
      search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)
        || $0.libraryTitle.localizedCaseInsensitiveContains(search)
        || buildingBlockSummary($0).localizedCaseInsensitiveContains(search)
    }
  }

  private func repositories(for profile: ConfigurationDocument) -> [ConfigurationDocument] {
    actions.list(.repository).filter { $0.payload["usualProfileId"]?.string == profile.id }
  }

  private func repositoryLabel(for profile: ConfigurationDocument) -> String {
    let matches = repositories(for: profile)
    if matches.isEmpty { return "No default repository" }
    if matches.count == 1 { return matches[0].libraryTitle }
    return "\(matches.count) repositories"
  }

  private func profileRows(for profile: ConfigurationDocument) -> [ProfileLibraryCard.Row] {
    let packs = profile.payload["toolPackIds"]?.array?.compactMap(\.string).map(referencedTitle) ?? []
    return [
      .init(icon: "shippingbox", label: "Environment", value: referencedTitle(profile.payload["environmentId"]?.string)),
      .init(icon: "sparkles", label: "AI setup", value: referencedTitle(profile.payload["aiId"]?.string)),
      .init(icon: "arrow.triangle.pull", label: "Workflow", value: referencedTitle(profile.payload["workflowId"]?.string)),
      .init(icon: "key", label: "Access", value: referencedTitle(profile.payload["githubAccessId"]?.string)),
      .init(icon: "wrench.and.screwdriver", label: "Tools", value: packs.isEmpty ? "None" : packs.joined(separator: ", ")),
    ]
  }

  private func referencedTitle(_ id: String?) -> String {
    guard let id, !id.isEmpty else { return "None" }
    return actions.documents.first(where: { $0.id == id })?.libraryTitle ?? "Unavailable"
  }

  private func buildingBlockSummary(_ document: ConfigurationDocument) -> String {
    switch document.kind {
    case .environment:
      return [document.payload["template"]?.string, document.payload["baseImage"]?.string]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    case .ai:
      let route = document.payload["main"]?.object
      let target = [route?["runtime"]?.string?.capitalized, route?["model"]?.string]
        .compactMap { $0 }.joined(separator: " · ")
      let reviewer = document.payload["reviewer"]?["mode"]?.string == "independent"
        ? "Independent review" : "Reviewer follows main"
      return [target, reviewer].filter { !$0.isEmpty }.joined(separator: " · ")
    case .workflow:
      let phases = document.payload["validationPhases"]?.array?.count ?? 0
      return [
        document.payload["agentMode"]?.string?.capitalized,
        document.payload["output"]?.string?.uppercased(),
        phases > 0 ? "\(phases) validation checks" : nil,
      ].compactMap { $0 }.joined(separator: " · ")
    case .githubAccess:
      let rules = document.payload["rules"]?.array?.count ?? 0
      return "\(rules) access \(rules == 1 ? "rule" : "rules")"
    case .toolPack:
      let capabilities = document.payload["requiredCapabilities"]?.array?.compactMap(\.string) ?? []
      return capabilities.isEmpty ? "Agent capabilities and integrations" : capabilities.joined(separator: " · ")
    case .repository:
      return document.payload["remote"]?.string ?? document.name
    case .profile:
      return profileRows(for: document).map(\.value).joined(separator: " · ")
    }
  }

  private func icon(for targetKind: ConfigurationKind) -> String {
    switch targetKind {
    case .repository: "shippingbox"
    case .environment: "shippingbox"
    case .ai: "sparkles"
    case .workflow: "arrow.triangle.pull"
    case .githubAccess: "key"
    case .toolPack: "wrench.and.screwdriver"
    case .profile: "person.crop.rectangle.stack"
    }
  }

  private func kindDescription(_ targetKind: ConfigurationKind) -> String {
    switch targetKind {
    case .environment: "Runtime and software"
    case .ai: "Models and review"
    case .workflow: "Validation and delivery"
    case .githubAccess: "Scoped permissions"
    case .toolPack: "Agent capabilities"
    default: ""
    }
  }

  private func kindLongDescription(_ targetKind: ConfigurationKind) -> String {
    switch targetKind {
    case .environment: "Runtime, software, and sidecar definitions."
    case .ai: "Models, reasoning, failover, and review behavior."
    case .workflow: "Validation, review, and daemon-owned delivery behavior."
    case .githubAccess: "Reusable repository permission scopes."
    case .toolPack: "Named skills and capabilities available to the agent."
    default: ""
    }
  }

  private func create(_ targetKind: ConfigurationKind) {
    editor = EditorTarget(kind: targetKind, document: nil, draft: nil)
  }

  private func edit(_ document: ConfigurationDocument) {
    editor = EditorTarget(kind: document.kind, document: document, draft: nil)
  }

  private func duplicate(_ document: ConfigurationDocument) {
    editor = EditorTarget(kind: document.kind, document: nil, draft: document)
  }

  private func archive(_ document: ConfigurationDocument) {
    Task {
      do { try await actions.archive(document) }
      catch { self.error = error.localizedDescription }
    }
  }

  private func usageCount(_ id: String) -> Int {
    func references(_ value: ConfigurationJSON) -> Bool {
      switch value { case .string(let text): text == id; case .array(let values): values.contains(where: references); case .object(let fields): fields.values.contains(where: references); default: false }
    }
    return actions.documents.filter { !$0.archived && $0.id != id && references(.object($0.payload)) }.count
  }
}

private struct RepositoryFilterMenu: View {
  let repositories: [ConfigurationDocument]
  @Binding var selectedID: String?
  @State private var presented = false
  @State private var search = ""

  var body: some View {
    Button { presented.toggle() } label: {
      HStack(spacing: 7) {
        Image(systemName: "shippingbox").foregroundStyle(.secondary)
        Text(selectionLabel).lineLimit(1)
        Spacer(minLength: 4)
        Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 10)
      .frame(width: 190, height: 34)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.quaternary))
    }
    .buttonStyle(.plain)
    .popover(isPresented: $presented, arrowEdge: .bottom) {
      VStack(spacing: 8) {
        TextField("Search repositories", text: $search).textFieldStyle(.roundedBorder)
        ScrollView {
          LazyVStack(spacing: 2) {
            repositoryButton(nil, title: "All repositories")
            ForEach(filteredRepositories) { repository in
              repositoryButton(repository.id, title: repository.libraryTitle)
            }
          }
        }
      }
      .padding(10)
      .frame(width: 300, height: 320)
    }
  }

  private var selectionLabel: String {
    guard let selectedID else { return "All repositories" }
    return repositories.first(where: { $0.id == selectedID })?.libraryTitle ?? "Repository"
  }

  private var filteredRepositories: [ConfigurationDocument] {
    repositories.filter { search.isEmpty || $0.libraryTitle.localizedCaseInsensitiveContains(search) }
  }

  private func repositoryButton(_ id: String?, title: String) -> some View {
    Button {
      selectedID = id
      presented = false
    } label: {
      HStack {
        Image(systemName: selectedID == id ? "checkmark.circle.fill" : "circle")
          .foregroundStyle(
            selectedID == id ? Color.accentColor : Color(nsColor: .tertiaryLabelColor)
          )
        Text(title).lineLimit(1)
        Spacer()
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct ProfileLibraryCard: View {
  struct Row: Identifiable {
    let icon: String
    let label: String
    let value: String
    var id: String { label }
  }
  let profile: ConfigurationDocument
  let repositoryLabel: String
  let rows: [Row]
  let usageCount: Int
  let onEdit: () -> Void
  let onDuplicate: () -> Void
  let onArchive: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        RoundedRectangle(cornerRadius: 8)
          .fill(Color.accentColor.opacity(0.18))
          .frame(width: 36, height: 36)
          .overlay(Text(profile.libraryTitle.prefix(1).uppercased()).font(.callout.bold()).foregroundStyle(Color.accentColor))
        VStack(alignment: .leading, spacing: 2) {
          Text(profile.libraryTitle).font(.headline).lineLimit(1)
          Text(repositoryLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
        Menu {
          Button("Edit", systemImage: "pencil", action: onEdit)
          Button("Duplicate", systemImage: "plus.square.on.square", action: onDuplicate)
          Divider()
          Button("Archive", systemImage: "archivebox", role: .destructive, action: onArchive)
            .disabled(usageCount > 0)
        } label: { Image(systemName: "ellipsis") }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }
      .padding(14)
      Divider()
      VStack(spacing: 0) {
        ForEach(rows) { row in
          HStack(spacing: 8) {
            Label(row.label, systemImage: row.icon)
              .font(.caption).foregroundStyle(.secondary).frame(width: 112, alignment: .leading)
            Text(row.value).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
          }
          .padding(.vertical, 8)
          if row.id != rows.last?.id { Divider() }
        }
      }
      .padding(.horizontal, 14)
      Divider()
      HStack {
        Label(usageLabel, systemImage: "arrow.triangle.branch")
          .font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Duplicate", action: onDuplicate).buttonStyle(.bordered).controlSize(.small)
        Button("Edit", action: onEdit).buttonStyle(.borderedProminent).controlSize(.small)
      }
      .padding(10)
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
    }
    .background(.background, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
  }

  private var usageLabel: String {
    "Used by \(usageCount) \(usageCount == 1 ? "configuration" : "configurations")"
  }
}

private struct BuildingBlockRow: View {
  let document: ConfigurationDocument
  let summary: String
  let usageCount: Int
  let onEdit: () -> Void
  let onDuplicate: () -> Void
  let onArchive: () -> Void
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "square.stack.3d.up")
        .foregroundStyle(.secondary)
        .frame(width: 34, height: 34)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      VStack(alignment: .leading, spacing: 3) {
        Text(document.libraryTitle).font(.headline).lineLimit(1)
        Text(summary.isEmpty ? "Reusable configuration" : summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        Text("Used by \(usageCount) \(usageCount == 1 ? "configuration" : "configurations")")
          .font(.caption2).foregroundStyle(Color.accentColor)
      }
      Spacer()
      Button("Duplicate", action: onDuplicate).buttonStyle(.bordered).controlSize(.small)
      Button("Edit", action: onEdit).buttonStyle(.borderedProminent).controlSize(.small)
      Menu {
        Button("Archive", systemImage: "archivebox", role: .destructive, action: onArchive)
          .disabled(usageCount > 0)
      } label: { Image(systemName: "ellipsis") }
      .menuStyle(.borderlessButton).fixedSize()
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.38), in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.quaternary))
  }
}

private struct RepositoryLibraryRow: View {
  let document: ConfigurationDocument
  let defaultProfile: String
  let usageCount: Int
  let onEdit: () -> Void
  let onDuplicate: () -> Void
  let onArchive: () -> Void
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "shippingbox").font(.title3).foregroundStyle(Color.accentColor).frame(width: 36)
      VStack(alignment: .leading, spacing: 3) {
        Text(document.libraryTitle).font(.headline)
        Text(document.payload["remote"]?.string ?? document.name).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 2) {
        Text("Default profile").font(.caption2).foregroundStyle(.secondary)
        Text(defaultProfile).font(.caption.weight(.medium)).lineLimit(1)
      }
      .frame(width: 150, alignment: .trailing)
      Button("Duplicate", action: onDuplicate).buttonStyle(.bordered).controlSize(.small)
      Button("Edit", action: onEdit).buttonStyle(.borderedProminent).controlSize(.small)
      Menu {
        Button("Archive", systemImage: "archivebox", role: .destructive, action: onArchive)
          .disabled(usageCount > 0)
      } label: { Image(systemName: "ellipsis") }
      .menuStyle(.borderlessButton).fixedSize()
    }
    .padding(12)
    .background(.background, in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.quaternary))
  }
}

struct ConfigurationEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  let kind: ConfigurationKind
  let document: ConfigurationDocument?
  let draft: ConfigurationDocument?
  let actions: LaunchConfigurationActions
  @State private var name: String
  @State private var payload: [String: ConfigurationJSON]
  @State private var busy = false
  @State private var error: String?
  @State private var rawJSON = ""
  @State private var showJSON = false
  @State private var showPim = false
  @State private var accounts: [PublicProviderAccountResponse] = []
  @State private var selectedSetup = ""
  @State private var repositoryTab = "Overview"
  @State private var repositoryChoices: [ConfigurationJSON] = []
  @State private var discoveringRepositories = false
  init(
    kind: ConfigurationKind,
    document: ConfigurationDocument?,
    draft: ConfigurationDocument? = nil,
    actions: LaunchConfigurationActions
  ) {
    self.kind = kind; self.document = document; self.draft = draft; self.actions = actions
    self._name = State(initialValue: document?.name ?? draft.map { "\($0.libraryTitle) copy" } ?? "")
    self._payload = State(initialValue: document?.payload ?? draft?.payload ?? Self.initial(kind))
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(document == nil ? (draft == nil ? "New \(kind.editorLabel)" : "Duplicate \(draft?.libraryTitle ?? "")") : "Edit \(document?.libraryTitle ?? "")").font(.title2.bold()).lineLimit(1).truncationMode(.middle)
      TextField(kind == .repository ? "Repository display name" : "\(kind.editorLabel) name", text: $name).textFieldStyle(.roundedBorder)
      if kind == .repository, name.contains("://"), let document {
        Button("Use short name: \(document.libraryTitle)") { name = document.libraryTitle }.font(.caption)
      }
      if let document { Text("Editing revision \(document.revision). Changes apply to future launches.").font(.caption).foregroundStyle(.secondary) }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          switch kind {
          case .profile: profileForm
          case .githubAccess: GitHubAccessRuleEditor(payload: $payload, actions: actions)
          case .ai: aiForm
          case .workflow: workflowForm
          case .repository: repositoryForm
          case .environment: environmentForm
          case .toolPack: toolPackForm
          }
          Button("Edit complete JSON…", systemImage: "curlybraces") {
            rawJSON = ConfigurationJSON.object(payload).formatted()
            showJSON = true
          }
          .buttonStyle(.link)
          .help("Advanced escape hatch for schema fields that do not have a dedicated control.")
        }.padding(4)
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack { Button("Cancel") { dismiss() }; Spacer(); if busy { ProgressView().controlSize(.small) }; Button("Save") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty) }
    }.padding(24).frame(width: 760, height: 740).background(Color(nsColor: .windowBackgroundColor)).textFieldStyle(.roundedBorder).disabled(busy)
    .sheet(isPresented: $showPim) { PimSelectionSheet(selected: payload["pim"]?.array?.compactMap(\.object) ?? [], discover: actions.discoverPim) { payload["pim"] = .array($0.map(ConfigurationJSON.object)) } }
    .sheet(isPresented: $showJSON) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Complete JSON").font(.title2.bold())
        Text("Advanced escape hatch. Secret values belong in credential references.").font(.callout).foregroundStyle(.secondary)
        TextEditor(text: $rawJSON).font(.system(.caption, design: .monospaced)).frame(minHeight: 360)
        if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        HStack {
          Button("Cancel") { showJSON = false }
          Spacer()
          Button("Apply") {
            applyJSON()
            if error == nil { showJSON = false }
          }.buttonStyle(.borderedProminent)
        }
      }.padding(24).frame(width: 680, height: 520)
    }
    .task { if kind == .ai { do { accounts = try await actions.loadProviderAccounts() } catch { self.error = error.localizedDescription } } }
  }
  private var profileForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationSection(title: "Build your profile", subtitle: "Choose reusable presets. A repository selects this profile as its default; you can choose another at launch.") {
        referencePicker(.environment, key: "environmentId")
        referencePicker(.ai, key: "aiId")
        referencePicker(.workflow, key: "workflowId")
        referencePicker(.githubAccess, key: "githubAccessId", optional: true)
      }
      GroupBox("Tool packs") { VStack(alignment: .leading) { ForEach(actions.list(.toolPack)) { pack in
        Toggle(pack.name, isOn: Binding(get: { payload["toolPackIds"]?.array?.contains(.string(pack.id)) ?? false }, set: { enabled in
          var values = payload["toolPackIds"]?.array ?? []; values.removeAll { $0 == .string(pack.id) }; if enabled { values.append(.string(pack.id)) }; payload["toolPackIds"] = .array(values)
        }))
      } } }
      ConfigurationSection(title: "Execution defaults") { ProfileExecutionDefaultsEditor(fields: objectBinding("execution"), capabilities: actions.capabilities) }
      Button("Choose PIM access · \(payload["pim"]?.array?.count ?? 0) selected") { showPim = true }
      referencePicker(.profile, key: "workerProfileId", optional: true)
    }
  }
  private func referencePicker(_ type: ConfigurationKind, key: String, optional: Bool = false) -> some View {
    Picker(key == "workerProfileId" ? "Workspace worker profile" : key == "usualProfileId" ? "Default profile" : type.label, selection: Binding(get: { payload[key]?.string ?? "" }, set: { payload[key] = $0.isEmpty && optional ? .null : .string($0) })) {
      Text(optional ? "None" : "Choose preset").tag("")
      ForEach(actions.list(type).filter { $0.id != document?.id }) { Text($0.libraryTitle).tag($0.id) }
    }
  }
  private var aiForm: some View {
    VStack(alignment: .leading, spacing: 14) {
      GroupBox("Main agent") { routeEditor(objectBinding("main")) }
      Picker("Reviewer", selection: Binding(get: { payload["reviewer"]?["mode"]?.string ?? "follow-main" }, set: { mode in
        payload["reviewer"] = .object(mode == "follow-main" ? ["mode": .string(mode)] : ["mode": .string(mode), "route": .object(Self.initialRoute)])
      })) { Text("Follow main").tag("follow-main"); Text("Independent account and model").tag("independent") }
      if payload["reviewer"]?["mode"]?.string == "independent" {
        GroupBox("Independent reviewer") { routeEditor(Binding(get: { payload["reviewer"]?["route"]?.object ?? [:] }, set: { payload["reviewer"] = .object(["mode": .string("independent"), "route": .object($0)]) })) }
      }
      Text("Each route owns its account, runtime, model and failover choices. Review usage counts within the whole-pod budget.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func routeEditor(_ route: Binding<[String: ConfigurationJSON]>) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      ConfigurationAgentTargetEditor(fields: route, accounts: accounts)
      Stepper("Maximum failover switches: \(Int(route.wrappedValue["maxHops"]?.number ?? 0))", value: Binding(get: { Int(route.wrappedValue["maxHops"]?.number ?? 0) }, set: { route.wrappedValue["maxHops"] = .number(Double($0)) }), in: 0...16)
      Text("Fallbacks are tried in order. Zero switches disables failover.").font(.caption).foregroundStyle(.secondary)
      ConfigurationObjectListEditor(title: "Fallback models", values: Binding(get: { route.wrappedValue["failover"]?.array ?? [] }, set: { route.wrappedValue["failover"] = .array($0) }), initial: {
        Self.initialRoute.filter { !["failover", "maxHops"].contains($0.key) }
      }) { ConfigurationAgentTargetEditor(fields: $0, accounts: accounts) }
    }.padding(6)
  }
  @ViewBuilder private var workflowForm: some View {
    let escalation = objectBinding("escalation")
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationSection(title: "How work runs", subtitle: "Choose the agent style and what the daemon should deliver.") {
        stringPicker("Agent mode", key: "agentMode", values: ["auto", "interactive"])
        stringPicker("Default intent", key: "intent", values: ["task", "goal"])
        stringPicker("Output", key: "output", values: ["pr", "branch", "artifact", "none"])
        stringPicker("Daemon delivery", key: "completion", values: ["approval", "deliver", "merge"])
        Toggle("Can be promoted from interactive to automatic", isOn: boolBinding("promotable"))
      }
      ConfigurationSection(title: "Validation checks") { LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 10) { ForEach(["setup", "lint", "sast", "build", "test", "health", "pages", "facts", "review", "advisory"], id: \.self) { phase in
        Toggle(phase.capitalized, isOn: Binding(get: { payload["validationPhases"]?.array?.contains(.string(phase)) ?? false }, set: { enabled in var values = payload["validationPhases"]?.array ?? []; values.removeAll { $0 == .string(phase) }; if enabled { values.append(.string(phase)) }; payload["validationPhases"] = .array(values) }))
      } }
        Toggle("Advisory browser QA", isOn: boolBinding("advisoryBrowserQaEnabled"))
        Stepper("Validation attempts: \(workflowInteger("maxValidationAttempts", fallback: 3))", value: integerBinding("maxValidationAttempts", fallback: 3), in: 1...10)
      }
      ConfigurationSection(title: "Budgets", subtitle: "Leave token limits off to use the selected model's normal limits.") {
        ConfigurationNumberValue(title: "Whole-pod token limit", fields: $payload, key: "tokenBudget", fallback: 100000, unsetLabel: "No token limit")
        ConfigurationNumberValue(title: "Reviewer token limit", fields: $payload, key: "reviewerTokenBudget", fallback: 10000, unsetLabel: "No separate limit")
        stringPicker("Budget policy", key: "tokenBudgetPolicy", values: ["soft", "hard"])
        ConfigurationNumberValue(title: "Budget extensions", fields: $payload, key: "maxBudgetExtensions", fallback: 0, unsetLabel: "Default policy")
      }
      ConfigurationSection(title: "Escalation", subtitle: "AI consultation uses the reviewer selected by the AI setup. Workflow presets only limit how often it may be used.") {
        Stepper("AI consultation limit: \(nestedInteger(escalation, group: "askAi", key: "maxCalls", fallback: 5))", value: nestedIntegerBinding(escalation, group: "askAi", key: "maxCalls", fallback: 5), in: 0...20)
        Toggle("Proactive AI advisor", isOn: nestedBoolBinding(escalation, group: "advisor", key: "enabled"))
        Stepper("Pause after \(workflowInteger(escalation, "autoPauseAfter", fallback: 3)) blockers", value: integerBinding(escalation, "autoPauseAfter", fallback: 3), in: 1...20)
        Picker("Wait for human", selection: integerBinding(escalation, "humanResponseTimeout", fallback: 3600)) {
          Text("15 minutes").tag(900)
          Text("1 hour").tag(3600)
          Text("2 hours").tag(7200)
          Text("6 hours").tag(21600)
          Text("24 hours").tag(86400)
        }
        Picker("If nobody responds", selection: stringBinding(escalation, "askHumanOnTimeout", fallback: "continue")) {
          Text("Continue with best judgement").tag("continue")
          Text("Ask the AI reviewer").tag("ask_ai")
        }
      }
      ConfigurationSection(title: "Delivery details") {
        ConfigurationTextValue(title: "Branch prefix", fields: $payload, key: "branchPrefix")
        stringPicker("Equivalent work", key: "preflightConflictPolicy", values: ["warn", "block"])
        LabeledContent("Merge status interval") {
          TextField("Seconds", value: numberBinding("mergePollIntervalSec", fallback: 60), format: .number).frame(width: 100)
          Text("seconds").foregroundStyle(.secondary)
        }
      }
      ConfigurationSection(title: "Completion instructions", subtitle: "Optional instructions for the agent when it finishes.") {
        ConfigurationTextValue(title: "Instructions", fields: $payload, key: "agentDonePrompt", optional: true, multiline: true)
      }
    }
  }
  private var repositoryForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("Repository settings", selection: $repositoryTab) {
        ForEach(["Overview", "Project setups", "Advanced"], id: \.self) { Text($0).tag($0) }
      }.pickerStyle(.segmented)
      if repositoryTab == "Overview" {
      ConfigurationSection(title: "Repository", subtitle: "Repository identity and the shared profile used for new launches.") {
      stringPicker("Source provider", key: "provider", values: ["github", "ado", "git"])
      if document == nil, payload["provider"]?.string == "github" {
        RepositoryMultiSelect(repositories: repositoryChoices, selectedIDs: Binding(get: {
          payload["providerRepositoryId"]?.string.map { [$0] } ?? []
        }, set: { ids in
          guard let id = ids.first, let repo = repositoryChoices.first(where: { $0["id"]?.string == id }),
                let owner = repo["ownerLogin"]?.string, let shortName = repo["name"]?.string else { return }
          payload["providerRepositoryId"] = .string(id)
          payload["remote"] = .string("https://github.com/\(owner)/\(shortName).git")
          name = shortName
          var setups = payload["setups"]?.array ?? []
          if setups.count == 1, var setup = setups[0].object {
            setup["defaultBranch"] = repo["defaultBranch"] ?? .string("main")
            setups[0] = .object(setup); payload["setups"] = .array(setups)
          }
        }), loading: discoveringRepositories, refresh: { Task { await discoverRepositories() } }, singleSelection: true)
        .task { if repositoryChoices.isEmpty { await discoverRepositories() } }
      }
      ConfigurationTextValue(title: "Repository HTTPS URL", fields: $payload, key: "remote")
      referencePicker(.profile, key: "usualProfileId", optional: true)
      }
      if let profile = actions.list(.profile).first(where: { $0.id == payload["usualProfileId"]?.string }) {
        ConfigurationSection(title: "Presets from \(profile.name)", subtitle: "This repository uses the selected profile's presets. Edit the profile to change the shared combination.") {
          ForEach([("environmentId", "Environment"), ("aiId", "AI setup"), ("workflowId", "Workflow"), ("githubAccessId", "GitHub access")], id: \.0) { key, label in
            LabeledContent(label, value: actions.documents.first(where: { $0.id == profile.payload[key]?.string })?.libraryTitle ?? "None")
          }
        }
      }
      if payload["usualProfileId"]?.string == nil || payload["usualProfileId"]?.string == "" {
        Text("Choose a profile to reuse its environment, AI, workflow and access presets. You can choose a different profile at launch.").font(.callout).foregroundStyle(.secondary)
      }
      }
      if repositoryTab == "Project setups" {
      Text("Project setups hold repository-specific commands and paths. Select one setup to edit.").font(.callout).foregroundStyle(.secondary)
      Picker("Default setup", selection: stringBinding("defaultSetupId")) {
        ForEach(payload["setups"]?.array?.compactMap(\.object) ?? [], id: \.["id"]) { setup in
          Text(setup["name"]?.string ?? "Unnamed setup").tag(setup["id"]?.string ?? "")
        }
      }
      repositorySetups
      }
      if repositoryTab == "Advanced" {
        ConfigurationSection(title: "Provider identity", subtitle: "AutoPod records this when a GitHub repository is selected. It prevents a renamed URL from silently pointing at a different repository.") {
          if payload["provider"]?.string == "github", let id = payload["providerRepositoryId"]?.string {
            LabeledContent("GitHub repository ID", value: id)
          } else {
            Text("This repository uses its HTTPS URL as its identity. No separate provider ID is needed.")
              .font(.callout).foregroundStyle(.secondary)
          }
        }
        ConfigurationSection(title: "Trusted project setups", subtitle: "Trust permits privileged sidecars such as Dagger when the execution backend supports them. Only trust reviewed setup definitions.") {
          let setups = payload["setups"]?.array?.compactMap(\.object) ?? []
          if setups.isEmpty { Text("No project setups available.").foregroundStyle(.secondary) }
          ForEach(setups, id: \.["id"]) { setup in
            let id = setup["id"]?.string ?? ""
            Toggle(setup["name"]?.string ?? id, isOn: Binding(get: {
              payload["trustedSetupIds"]?.array?.contains(.string(id)) ?? false
            }, set: { enabled in
              var ids = payload["trustedSetupIds"]?.array ?? []
              ids.removeAll { $0 == .string(id) }
              if enabled { ids.append(.string(id)) }
              payload["trustedSetupIds"] = .array(ids)
            }))
          }
          Label("Leave all setups untrusted unless one genuinely needs a privileged sidecar.", systemImage: "shield.lefthalf.filled")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
    }
  }
  private var environmentForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      stringPicker("Template", key: "template", values: ["node22", "node22-pw", "node22-pw-pg", "node24", "node24-pw", "dotnet9", "dotnet10", "dotnet10-go", "python312", "python-node", "python-node-pg", "go124", "go124-pw", "custom"])
      Text("Software and sidecar definitions belong here. Docker/sandbox and resource sizes are chosen by the profile or at launch.").font(.caption).foregroundStyle(.secondary)
      ConfigurationTextValue(title: "Base image (optional)", fields: $payload, key: "baseImage", optional: true)
      Text("Additional software").font(.headline)
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "info.circle").foregroundStyle(Color.accentColor)
        VStack(alignment: .leading, spacing: 6) {
          Text("Install extra packages in the pod environment").font(.callout.weight(.semibold))
          Text("Choose a package type, then enter its name and version. pnpm and Playwright only need a version; npm, Python and .NET packages also need a name.")
          Text("Example: choose npm package, enter typescript, then version 5.7.3. Prefixes are added automatically. Use an exact published version, not latest or a range such as ^5.7.")
          Text("Leave this list empty if the template already includes what you need. Remove unused rows with the minus button. Agent skills and MCP connections belong in Tool packs.")
        }.font(.callout).fixedSize(horizontal: false, vertical: true)
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
      ConfigurationObjectListEditor(title: "Packages", values: arrayBinding("tools"), initial: { ["name": .string("pnpm"), "version": .string("")] }) { fields in
        ConfigurationSoftwarePackageEditor(fields: fields)
      }
      ConfigurationStringListEditor(title: "Image preparation commands", values: arrayBinding("prepareCommands"))
      ConfigurationObjectListEditor(title: "Sidecars", values: arrayBinding("sidecars"), initial: { ["id": .string("service-\(UUID().uuidString.prefix(8).lowercased())"), "type": .string("postgres"), "image": .string(""), "version": .string(""), "startup": .string("on-demand"), "port": .number(5432)] }) { EnvironmentSidecarEditor(fields: $0) }
      ConfigurationCapabilitiesEditor(values: arrayBinding("capabilities"))
    }
  }
  private var toolPackForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationObjectListEditor(title: "Instructions", values: arrayBinding("instructions"), initial: { ["heading": .string(""), "content": .string("")] }) { fields in
        VStack { ConfigurationTextValue(title: "Heading", fields: fields, key: "heading"); ConfigurationTextValue(title: "Instructions", fields: fields, key: "content", multiline: true) }
      }
      ConfigurationObjectListEditor(title: "Skills", values: arrayBinding("skills"), initial: { ["name": .string(""), "source": .object(["type": .string("builtin")])] }) { SkillSourceEditor(fields: $0, repositories: actions.list(.repository)) }
      ConfigurationObjectListEditor(title: "MCP servers", values: arrayBinding("mcpServers"), initial: { ["name": .string(""), "transport": .object(["type": .string("http"), "url": .string(""), "headers": .object([:])])] }) { McpTransportEditor(fields: $0) }
      ConfigurationStringListEditor(title: "Required capabilities", values: arrayBinding("requiredCapabilities"))
      Text("Tool packs provide tools and instructions. Access is selected separately.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func arrayBinding(_ key: String) -> Binding<[ConfigurationJSON]> { Binding(get: { payload[key]?.array ?? [] }, set: { payload[key] = .array($0) }) }
  private var repositorySetups: some View {
    let setups = payload["setups"]?.array ?? []
    let selected = setups.firstIndex { $0["id"]?.string == selectedSetup } ?? 0
    return ConfigurationSection(title: "Project setups") {
      HStack {
        Picker("Editing", selection: Binding(get: { setups.indices.contains(selected) ? setups[selected]["id"]?.string ?? "" : "" }, set: { selectedSetup = $0 })) {
          ForEach(setups.compactMap(\.object), id: \.["id"]) { setup in Text(setup["name"]?.string ?? "Unnamed").tag(setup["id"]?.string ?? "") }
        }
        Button("Add setup", systemImage: "plus") {
          let id = "setup-\(UUID().uuidString.prefix(8).lowercased())"
          payload["setups"] = .array(setups + [.object(["id": .string(id), "name": .string("New setup"), "defaultBranch": .string("main")])])
          selectedSetup = id
        }
      }
      if setups.indices.contains(selected) {
        RepositorySetupEditor(fields: Binding(get: { payload["setups"]?.array?.first { $0["id"] == setups[selected]["id"] }?.object ?? [:] }, set: { fields in
          var current = payload["setups"]?.array ?? []
          guard let index = current.firstIndex(where: { $0["id"] == setups[selected]["id"] }) else { return }
          current[index] = .object(fields); payload["setups"] = .array(current)
        })).id(setups[selected]["id"])
        Button("Remove this setup", role: .destructive) {
          var current = payload["setups"]?.array ?? []
          current.removeAll { $0["id"] == setups[selected]["id"] }
          payload["setups"] = .array(current)
          selectedSetup = payload["defaultSetupId"]?.string ?? ""
        }
        .disabled(setups.count <= 1 || setups[selected]["id"] == payload["defaultSetupId"] || (payload["trustedSetupIds"]?.array?.contains(setups[selected]["id"] ?? .null) ?? false))
        .help("Default and trusted setups must remain available. Change their selections before removing them.")
      }
    }
  }
  private func discoverRepositories() async {
    guard !discoveringRepositories else { return }
    discoveringRepositories = true
    defer { discoveringRepositories = false }
    do { repositoryChoices = try await actions.discoverGitHubRepositories() }
    catch { self.error = error.localizedDescription }
  }
  private func objectBinding(_ key: String) -> Binding<[String: ConfigurationJSON]> { Binding(get: { payload[key]?.object ?? [:] }, set: { payload[key] = .object($0) }) }
  private func stringBinding(_ key: String) -> Binding<String> { Binding(get: { payload[key]?.string ?? "" }, set: { payload[key] = .string($0) }) }
  private func boolBinding(_ key: String, fallback: Bool = false) -> Binding<Bool> { Binding(get: { payload[key]?.bool ?? fallback }, set: { payload[key] = .bool($0) }) }
  private func numberBinding(_ key: String, fallback: Double) -> Binding<Double> { Binding(get: { payload[key]?.number ?? fallback }, set: { payload[key] = .number($0) }) }
  private func integerBinding(_ key: String, fallback: Int) -> Binding<Int> { Binding(get: { workflowInteger(key, fallback: fallback) }, set: { payload[key] = .number(Double($0)) }) }
  private func workflowInteger(_ key: String, fallback: Int) -> Int { Int(payload[key]?.number ?? Double(fallback)) }
  private func workflowInteger(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String, fallback: Int) -> Int { Int(fields.wrappedValue[key]?.number ?? Double(fallback)) }
  private func integerBinding(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String, fallback: Int) -> Binding<Int> { Binding(get: { workflowInteger(fields, key, fallback: fallback) }, set: { fields.wrappedValue[key] = .number(Double($0)) }) }
  private func stringBinding(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String, fallback: String) -> Binding<String> { Binding(get: { fields.wrappedValue[key]?.string ?? fallback }, set: { fields.wrappedValue[key] = .string($0) }) }
  private func nestedInteger(_ fields: Binding<[String: ConfigurationJSON]>, group: String, key: String, fallback: Int) -> Int { Int(fields.wrappedValue[group]?[key]?.number ?? Double(fallback)) }
  private func nestedIntegerBinding(_ fields: Binding<[String: ConfigurationJSON]>, group: String, key: String, fallback: Int) -> Binding<Int> { Binding(get: { nestedInteger(fields, group: group, key: key, fallback: fallback) }, set: { var nested = fields.wrappedValue[group]?.object ?? [:]; nested[key] = .number(Double($0)); fields.wrappedValue[group] = .object(nested) }) }
  private func nestedBoolBinding(_ fields: Binding<[String: ConfigurationJSON]>, group: String, key: String) -> Binding<Bool> { Binding(get: { fields.wrappedValue[group]?[key]?.bool ?? false }, set: { var nested = fields.wrappedValue[group]?.object ?? [:]; nested[key] = .bool($0); fields.wrappedValue[group] = .object(nested) }) }
  private func stringPicker(_ title: String, key: String, values: [String]) -> some View {
    Picker(title, selection: Binding(get: { payload[key]?.string ?? values.first ?? "" }, set: { payload[key] = .string($0) })) {
      ForEach(values, id: \.self) { Text($0 == "pr" ? "Pull request" : $0.capitalized).tag($0) }
    }
  }
  private func applyJSON() { do { guard let fields = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(rawJSON.utf8)).object else { throw LaunchJSONError.invalid("Preset payload must be an object") }; payload = fields; error = nil } catch { self.error = error.localizedDescription } }
  private func save() async { busy = true; defer { busy = false }; do { _ = try await actions.save(kind, ConfigurationWriteRequest(id: document?.id, name: name, payload: payload, expectedRevision: document?.revision)); dismiss() } catch { self.error = error.localizedDescription } }
  private static var initialRoute: [String: ConfigurationJSON] { ["providerAccountId": .string(""), "runtime": .string("claude"), "model": .string(""), "reasoningEffort": .string("auto"), "failover": .array([]), "maxHops": .number(0)] }
  private static func initial(_ kind: ConfigurationKind) -> [String: ConfigurationJSON] {
    switch kind {
    case .profile: ["environmentId": .string(""), "aiId": .string(""), "workflowId": .string(""), "githubAccessId": .null, "toolPackIds": .array([]), "execution": .object(["target": .string("local"), "main": .object(["memoryGb": .null, "cpus": .null, "storageGb": .null]), "sidecars": .object([:])]), "pim": .array([]), "workerProfileId": .null]
    case .githubAccess: ["rules": .array([])]
    case .ai: ["main": .object(initialRoute), "reviewer": .object(["mode": .string("follow-main")])]
    case .workflow: ["agentMode": .string("auto"), "intent": .string("task"), "output": .string("pr"), "completion": .string("approval"), "validationPhases": .array(["setup", "build", "test", "review"].map(ConfigurationJSON.string)), "tokenBudget": .null, "reviewerTokenBudget": .null]
    case .repository: ["provider": .string("github"), "remote": .string(""), "providerRepositoryId": .null, "usualProfileId": .null, "setups": .array([.object(["id": .string("default"), "name": .string("Default"), "defaultBranch": .string("main"), "buildCommand": .null, "testCommand": .null])]), "defaultSetupId": .string("default"), "trustedSetupIds": .array([])]
    case .environment: ["template": .string("node22"), "baseImage": .null, "tools": .array([]), "prepareCommands": .array([]), "capabilities": .array([]), "sidecars": .array([])]
    case .toolPack: ["instructions": .array([]), "skills": .array([]), "mcpServers": .array([]), "requiredCapabilities": .array([])]
    }
  }
}

/// Unknown/new nested fields remain in the document. The daemon remains the schema authority.
struct ConfigurationFieldsEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  var excluded: Set<String> = []
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(fields.keys.filter { !excluded.contains($0) }.sorted(), id: \.self) { key in
        if let value = fields[key] { field(key, value) }
      }
    }
  }
  private func field(_ key: String, _ value: ConfigurationJSON) -> AnyView {
    let title = key.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized
    switch value {
    case .bool: return AnyView(Toggle(title, isOn: Binding(get: { fields[key]?.bool ?? false }, set: { fields[key] = .bool($0) })))
    case .string: return AnyView(ConfigurationTextValue(title: title, fields: $fields, key: key))
    case .number: return AnyView(LabeledContent(title) { TextField(title, value: Binding(get: { fields[key]?.number ?? 0 }, set: { fields[key] = .number($0) }), format: .number).frame(width: 120) })
    case .object: return AnyView(ConfigurationSection(title: title) { ConfigurationFieldsEditor(fields: Binding(get: { fields[key]?.object ?? [:] }, set: { fields[key] = .object($0) })) })
    default: return AnyView(ConfigurationJSONField(title: title, value: Binding(get: { fields[key] ?? .null }, set: { fields[key] = $0 })))
    }
  }
}
private struct ConfigurationJSONField: View {
  let title: String
  @Binding var value: ConfigurationJSON
  @State private var text = ""
  @State private var error: String?
  var body: some View {
    DisclosureGroup(title) {
      VStack(alignment: .leading) {
        TextEditor(text: $text).font(.system(.caption, design: .monospaced)).frame(minHeight: 55, maxHeight: 150)
        HStack { Button("Apply") { do { value = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(text.utf8)); error = nil } catch { self.error = error.localizedDescription } }; if let error { Text(error).font(.caption).foregroundStyle(.red) } }
      }
    }.onAppear { text = value.formatted() }.onChange(of: value) { _, latest in text = latest.formatted() }
  }
}
