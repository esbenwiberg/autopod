import SwiftUI

/// Spotlight-style command palette triggered by Cmd+K.
public struct CommandPalette: View {
  @Binding public var isPresented: Bool
  public let pods: [Pod]
  public var actions: PodActions
  public var onSelectSession: ((String) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    pods: [Pod] = [],
    actions: PodActions = .preview,
    onSelectSession: ((String) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.pods = pods
    self.actions = actions
    self.onSelectSession = onSelectSession
  }

  @State private var query = ""
  @State private var selectedIndex = 0

  private var results: [PaletteItem] {
    let q = query.lowercased()

    var items: [PaletteItem] = []

    // Pods matching query
    let matchingSessions = pods.filter { pod in
      q.isEmpty || pod.branch.lowercased().contains(q)
        || pod.profileName.lowercased().contains(q)
        || pod.status.label.lowercased().contains(q)
    }.prefix(6)

    for pod in matchingSessions {
      items.append(.pod(pod))
    }

    // Actions (always shown, filtered by query)
    let actionItems: [(String, String, () -> Void)] = [
      ("New Pod", "plus.circle", { }),
      ("Approve All Validated", "checkmark.circle", { Task { await actions.approveAll() }; isPresented = false }),
      ("Kill All Failed", "xmark.circle", { Task { await actions.killAllFailed() }; isPresented = false }),
    ]

    for (name, icon, action) in actionItems {
      if q.isEmpty || name.lowercased().contains(q) {
        items.append(.action(name: name, icon: icon, action: action))
      }
    }

    return items
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
          .onSubmit { executeSelected() }
      }
      .padding(12)

      Divider()

      // Results
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if results.isEmpty {
            Text("No results")
              .font(.caption)
              .foregroundStyle(.tertiary)
              .padding(12)
          } else {
            ForEach(Array(results.enumerated()), id: \.offset) { index, item in
              paletteRow(item, isSelected: index == selectedIndex)
                .onTapGesture { executeItem(item) }
                .onHover { if $0 { selectedIndex = index } }
            }
          }
        }
      }
      .frame(maxHeight: 300)
    }
    .frame(width: 480)
    .background(.ultraThinMaterial)
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
    .onChange(of: query) { _, _ in selectedIndex = 0 }
  }

  // MARK: - Row

  @ViewBuilder
  private func paletteRow(_ item: PaletteItem, isSelected: Bool) -> some View {
    HStack(spacing: 10) {
      switch item {
      case .pod(let pod):
        Circle()
          .fill(pod.status.color)
          .frame(width: 8, height: 8)
        VStack(alignment: .leading, spacing: 1) {
          Text(pod.branch)
            .font(.system(.callout, design: .monospaced))
          Text("\(pod.profileName) — \(pod.status.label)")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      case .action(let name, let icon, _):
        Image(systemName: icon)
          .foregroundStyle(.blue)
          .frame(width: 16)
        Text(name)
          .font(.callout)
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

  private func executeItem(_ item: PaletteItem) {
    switch item {
    case .pod(let pod):
      onSelectSession?(pod.id)
      isPresented = false
    case .action(_, _, let action):
      action()
    }
  }
}

// MARK: - Palette item

private enum PaletteItem {
  case pod(Pod)
  case action(name: String, icon: String, action: () -> Void)
}
