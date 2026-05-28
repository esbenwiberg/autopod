import AppKit
import SwiftUI

/// Spotlight-style command palette triggered by Cmd+K.
public struct CommandPalette: View {
  @Binding public var isPresented: Bool
  public let pods: [Pod]
  public let profiles: [Profile]
  public var actions: PodActions
  public var onSelectSession: ((String) -> Void)?
  public var onCreatePod: (() -> Void)?
  public var onShowProfilePods: ((String) -> Void)?
  public var onEditProfile: ((String) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    pods: [Pod] = [],
    profiles: [Profile] = [],
    actions: PodActions = .preview,
    onSelectSession: ((String) -> Void)? = nil,
    onCreatePod: (() -> Void)? = nil,
    onShowProfilePods: ((String) -> Void)? = nil,
    onEditProfile: ((String) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.pods = pods
    self.profiles = profiles
    self.actions = actions
    self.onSelectSession = onSelectSession
    self.onCreatePod = onCreatePod
    self.onShowProfilePods = onShowProfilePods
    self.onEditProfile = onEditProfile
  }

  @State private var query = ""
  @State private var selectedIndex = 0
  @State private var keyMonitor: Any?
  @FocusState private var queryFocused: Bool

  private var results: [CommandPaletteResult] {
    Self.results(query: query, pods: pods, profiles: profiles)
  }

  public var body: some View {
    VStack(spacing: 0) {
      // Search field
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
        TextField("Type a command or search…", text: $query)
          .textFieldStyle(.plain)
          .font(.system(.body))
          .focused($queryFocused)
          .onSubmit { executeSelected() }
      }
      .padding(12)

      Divider()

      // Results
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            if results.isEmpty {
              Text("No results")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(12)
            } else {
              ForEach(Array(results.enumerated()), id: \.element.id) { index, item in
                paletteRow(item, isSelected: index == selectedIndex)
                  .id(item.id)
                  .onTapGesture { executeItem(item) }
                  .onHover { if $0 { selectedIndex = index } }
              }
            }
          }
        }
        .onChange(of: selectedIndex) { _, newIndex in
          guard results.indices.contains(newIndex) else { return }
          withAnimation(.easeOut(duration: 0.12)) {
            proxy.scrollTo(results[newIndex].id, anchor: .center)
          }
        }
      }
      .frame(maxHeight: 300)
    }
    .frame(width: 480)
    .background(.ultraThinMaterial)
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
    .onAppear {
      DispatchQueue.main.async { queryFocused = true }
      installKeyboardMonitor()
    }
    .onDisappear { removeKeyboardMonitor() }
    .onChange(of: results.map(\.id)) { _, ids in
      if ids.isEmpty {
        selectedIndex = 0
      } else {
        selectedIndex = min(selectedIndex, ids.count - 1)
      }
    }
    .onChange(of: query) { _, _ in selectedIndex = 0 }
  }

  // MARK: - Row

  @ViewBuilder
  private func paletteRow(_ item: CommandPaletteResult, isSelected: Bool) -> some View {
    HStack(spacing: 10) {
      switch item.kind {
      case .pod(let id):
        let pod = pods.first { $0.id == id }
        Circle()
          .fill(pod?.status.color ?? Color.secondary)
          .frame(width: 8, height: 8)
        VStack(alignment: .leading, spacing: 1) {
          Text(item.title)
            .font(.system(.callout, design: .monospaced))
          if let subtitle = item.subtitle {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      case .action, .showProfilePods, .editProfile:
        Image(systemName: item.systemImage)
          .foregroundStyle(iconColor(for: item.kind))
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 1) {
          Text(item.title)
            .font(.callout)
          if let subtitle = item.subtitle {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      Spacer()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(isSelected ? Color.accentColor.opacity(0.1) : .clear)
    .contentShape(Rectangle())
  }

  // MARK: - Execute

  private func executeSelected() {
    guard selectedIndex < results.count else { return }
    executeItem(results[selectedIndex])
  }

  private func executeItem(_ item: CommandPaletteResult) {
    switch item.kind {
    case .pod(let id):
      onSelectSession?(id)
      isPresented = false
    case .action(.newPod):
      onCreatePod?()
      isPresented = false
    case .action(.approveAllValidated):
      Task { await actions.approveAll() }
      isPresented = false
    case .action(.killAllFailed):
      Task { await actions.killAllFailed() }
      isPresented = false
    case .showProfilePods(let name):
      onShowProfilePods?(name)
      isPresented = false
    case .editProfile(let name):
      onEditProfile?(name)
      isPresented = false
    }
  }

  private func moveSelection(_ offset: Int) {
    guard !results.isEmpty else {
      selectedIndex = 0
      return
    }
    selectedIndex = (selectedIndex + offset + results.count) % results.count
  }

  private func installKeyboardMonitor() {
    guard keyMonitor == nil else { return }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      guard isPresented else { return event }
      switch event.keyCode {
      case 125:
        moveSelection(1)
        return nil
      case 126:
        moveSelection(-1)
        return nil
      case 36, 76:
        executeSelected()
        return nil
      case 53:
        isPresented = false
        return nil
      default:
        return event
      }
    }
  }

  private func removeKeyboardMonitor() {
    guard let keyMonitor else { return }
    NSEvent.removeMonitor(keyMonitor)
    self.keyMonitor = nil
  }

  private func iconColor(for kind: CommandPaletteResult.Kind) -> Color {
    switch kind {
    case .action(.killAllFailed):
      .red
    case .showProfilePods:
      .indigo
    case .editProfile:
      .purple
    default:
      .blue
    }
  }
}

// MARK: - Results

enum CommandPaletteAction: Equatable, Sendable {
  case newPod
  case approveAllValidated
  case killAllFailed

  var title: String {
    switch self {
    case .newPod: "New Pod"
    case .approveAllValidated: "Approve All Validated"
    case .killAllFailed: "Kill All Failed"
    }
  }

  var systemImage: String {
    switch self {
    case .newPod: "plus.circle"
    case .approveAllValidated: "checkmark.circle"
    case .killAllFailed: "xmark.circle"
    }
  }
}

struct CommandPaletteResult: Identifiable, Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    case pod(String)
    case action(CommandPaletteAction)
    case showProfilePods(String)
    case editProfile(String)
  }

  let kind: Kind
  let title: String
  let subtitle: String?
  let systemImage: String

  var id: String {
    switch kind {
    case .pod(let id):
      "pod:\(id)"
    case .action(let action):
      "action:\(action)"
    case .showProfilePods(let name):
      "profile-pods:\(name)"
    case .editProfile(let name):
      "profile-edit:\(name)"
    }
  }
}

extension CommandPalette {
  static func results(
    query: String,
    pods: [Pod],
    profiles: [Profile],
    maxPods: Int = 6,
    maxProfiles: Int = 6
  ) -> [CommandPaletteResult] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    var items: [CommandPaletteResult] = []

    let actions: [CommandPaletteAction] = [
      .newPod,
      .approveAllValidated,
      .killAllFailed,
    ]
    for action in actions where textMatches(trimmed, in: [action.title]) {
      items.append(CommandPaletteResult(
        kind: .action(action),
        title: action.title,
        subtitle: nil,
        systemImage: action.systemImage
      ))
    }

    let matchingPods = (trimmed.isEmpty ? pods : MainView.searchPods(pods, query: trimmed))
      .prefix(maxPods)
    for pod in matchingPods {
      items.append(CommandPaletteResult(
        kind: .pod(pod.id),
        title: pod.branch,
        subtitle: "\(pod.profileName) - \(pod.status.label) - \(pod.id)",
        systemImage: "circle.fill"
      ))
    }

    let matchingProfiles = profiles
      .filter { profileMatches($0, query: trimmed) }
      .sorted { $0.name < $1.name }
      .prefix(maxProfiles)
    for profile in matchingProfiles {
      let subtitle = profileSubtitle(profile)
      items.append(CommandPaletteResult(
        kind: .showProfilePods(profile.name),
        title: "Show Pods for \(profile.name)",
        subtitle: subtitle,
        systemImage: "line.3.horizontal.decrease.circle"
      ))
      items.append(CommandPaletteResult(
        kind: .editProfile(profile.name),
        title: "Edit Profile \(profile.name)",
        subtitle: subtitle,
        systemImage: "square.and.pencil"
      ))
    }

    return items
  }

  private static func profileMatches(_ profile: Profile, query: String) -> Bool {
    textMatches(query, in: [
      profile.name,
      profile.repoUrl,
      profile.extendsProfile ?? "",
      "show pods for \(profile.name)",
      "edit profile \(profile.name)",
    ])
  }

  private static func textMatches(_ query: String, in fields: [String]) -> Bool {
    let tokens = query
      .lowercased()
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)
    guard !tokens.isEmpty else { return true }
    let haystack = fields.joined(separator: " ").lowercased()
    return tokens.allSatisfy { haystack.contains($0) }
  }

  private static func profileSubtitle(_ profile: Profile) -> String {
    if let parent = profile.extendsProfile, !parent.isEmpty {
      return "\(profile.repoUrl) - extends \(parent)"
    }
    return profile.repoUrl
  }
}
