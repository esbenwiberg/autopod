import SwiftUI

/// Spotlight-style command palette triggered by Cmd+K.
public struct CommandPalette: View {
  @Binding public var isPresented: Bool
  public let sessions: [Session]
  public var actions: SessionActions
  public var onSelectSession: ((String) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    sessions: [Session] = [],
    actions: SessionActions = .preview,
    onSelectSession: ((String) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.sessions = sessions
    self.actions = actions
    self.onSelectSession = onSelectSession
  }

  @State private var query = ""
  @State private var selectedIndex = 0

  private var results: [PaletteItem] {
    let q = query.lowercased()

    var items: [PaletteItem] = []

    // Sessions matching query
    let matchingSessions = sessions.filter { session in
      q.isEmpty || session.branch.lowercased().contains(q)
        || session.profileName.lowercased().contains(q)
        || session.status.label.lowercased().contains(q)
    }.prefix(6)

    for session in matchingSessions {
      items.append(.session(session))
    }

    // Actions (always shown, filtered by query)
    let actionItems: [(String, String, () -> Void)] = [
      ("New Session", "plus.circle", { }),
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
      case .session(let session):
        Circle()
          .fill(session.status.color)
          .frame(width: 8, height: 8)
        VStack(alignment: .leading, spacing: 1) {
          Text(session.branch)
            .font(.system(.callout, design: .monospaced))
          Text("\(session.profileName) — \(session.status.label)")
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
    case .session(let session):
      onSelectSession?(session.id)
      isPresented = false
    case .action(_, _, let action):
      action()
    }
  }
}

// MARK: - Palette item

private enum PaletteItem {
  case session(Session)
  case action(name: String, icon: String, action: () -> Void)
}
