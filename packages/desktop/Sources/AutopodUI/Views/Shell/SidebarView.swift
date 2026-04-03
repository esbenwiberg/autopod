import SwiftUI

/// Sidebar with smart groups, profiles, and connection status.
public struct SidebarView: View {
    public let sessions: [Session]
    @Binding public var selection: SidebarItem
    @Binding public var showCreateSheet: Bool
    public var isConnected: Bool
    public var connectionLabel: String
    public var onShowSettings: (() -> Void)?

    public init(
        sessions: [Session],
        selection: Binding<SidebarItem>,
        showCreateSheet: Binding<Bool>,
        isConnected: Bool = true,
        connectionLabel: String = "localhost:3000",
        onShowSettings: (() -> Void)? = nil
    ) {
        self.sessions = sessions
        self._selection = selection
        self._showCreateSheet = showCreateSheet
        self.isConnected = isConnected
        self.connectionLabel = connectionLabel
        self.onShowSettings = onShowSettings
    }

    private var attentionCount: Int { sessions.filter { $0.status.needsAttention }.count }
    private var runningCount: Int { sessions.filter { $0.status.isActive && !$0.isWorkspace }.count }
    private var workspaceCount: Int { sessions.filter { $0.isWorkspace }.count }
    private var completedCount: Int { sessions.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }.count }
    private var profiles: [String] { Array(Set(sessions.map(\.profileName))).sorted() }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Connection indicator
            connectionHeader

            Divider().padding(.bottom, 8)

            // New session button
            Button {
                showCreateSheet = true
            } label: {
                Label("New Session", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .padding(.horizontal, 12)
            .padding(.bottom, 12)

            // Smart groups
            List(selection: $selection) {
                Section("Sessions") {
                    sidebarRow(.attention, icon: "exclamationmark.circle.fill", color: .orange, badge: attentionCount)
                    sidebarRow(.running, icon: "play.circle.fill", color: .secondary, badge: runningCount)
                    sidebarRow(.workspaces, icon: "terminal.fill", color: .secondary, badge: workspaceCount)
                    sidebarRow(.completed, icon: "checkmark.circle.fill", color: .secondary, badge: completedCount)
                    sidebarRow(.all, icon: "square.grid.2x2", color: .secondary, badge: sessions.count)
                    sidebarRow(.analytics, icon: "chart.bar.fill", color: .secondary, badge: 0)
                }

                Section("Profiles") {
                    ForEach(profiles, id: \.self) { profile in
                        sidebarRow(.profile(profile), icon: "folder.fill", color: .secondary, badge: sessions.filter { $0.profileName == profile }.count)
                    }
                }
            }
            .listStyle(.sidebar)

            Spacer()

            // Bottom bar — explore link + settings
            Divider()
            VStack(spacing: 2) {
                exploreButton(.salesPitch, icon: "bolt.fill", label: "Why Autopod")
                exploreButton(.featureOverview, icon: "sparkles", label: "How it Works")
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            Divider()
            HStack {
                Button {
                    onShowSettings?()
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("Settings")
                Spacer()
            }
            .padding(12)
        }
        .background(.ultraThinMaterial)
        .frame(minWidth: 180, idealWidth: 200, maxWidth: 220)
    }

    // MARK: - Connection header

    private var connectionHeader: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(isConnected ? .green : .red)
                .frame(width: 7, height: 7)
            Text(connectionLabel)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Row

    private func exploreButton(_ item: SidebarItem, icon: String, label: String) -> some View {
        Button {
            selection = item
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(selection == item ? .blue : .secondary)
                    .frame(width: 18)
                Text(label)
                    .font(.system(.caption).weight(.medium))
                    .foregroundStyle(selection == item ? .primary : .secondary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(selection == item ? Color.blue.opacity(0.1) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    private func sidebarRow(_ item: SidebarItem, icon: String, color: Color, badge: Int) -> some View {
        Label {
            HStack {
                Text(item.label)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.system(.caption2).weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(color.opacity(0.12))
                        .foregroundStyle(color)
                        .clipShape(Capsule())
                }
            }
        } icon: {
            Image(systemName: icon)
                .foregroundStyle(color)
        }
        .tag(item)
    }
}

// MARK: - Sidebar items

public enum SidebarItem: Hashable {
    case attention
    case running
    case workspaces
    case completed
    case all
    case analytics
    case profile(String)
    case featureOverview
    case salesPitch

    public var label: String {
        switch self {
        case .attention: "Attention"
        case .running: "Running"
        case .workspaces: "Workspaces"
        case .completed: "Completed"
        case .all: "All Sessions"
        case .analytics: "Analytics"
        case .profile(let name): name
        case .featureOverview: "How it Works"
        case .salesPitch: "Why Autopod"
        }
    }
}

// MARK: - Preview

#Preview("Sidebar") {
    @Previewable @State var selection: SidebarItem = .attention
    @Previewable @State var showCreate = false
    SidebarView(sessions: MockData.all, selection: $selection, showCreateSheet: $showCreate)
        .frame(height: 500)
}
