import SwiftUI

/// Profile list — shows all profiles with quick stats, click to edit.
public struct ProfileListView: View {
    public let profiles: [Profile]
    public init(profiles: [Profile]) { self.profiles = profiles }

    @State private var selectedProfile: Profile?
    @State private var showCreateSheet = false

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Profiles")
                    .font(.headline)
                Text("\(profiles.count)")
                    .font(.system(.caption2).weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.blue.opacity(0.1))
                    .foregroundStyle(.blue)
                    .clipShape(Capsule())
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

            Divider()

            // Profile cards
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(profiles) { profile in
                        ProfileCard(profile: profile)
                            .onTapGesture { selectedProfile = profile }
                    }
                }
                .padding(16)
            }
        }
        .sheet(item: $selectedProfile) { profile in
            ProfileEditorView(profile: profile, isNew: false)
        }
        .sheet(isPresented: $showCreateSheet) {
            ProfileEditorView(
                profile: Profile(name: "", repoUrl: ""),
                isNew: true
            )
        }
    }
}

// MARK: - Profile card

struct ProfileCard: View {
    let profile: Profile
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 14) {
            // Template icon
            templateIcon

            // Info
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(profile.name)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                    Text(profile.template.label)
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.08))
                        .foregroundStyle(.blue)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    if profile.executionTarget == .aci {
                        Text("ACI")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.purple.opacity(0.08))
                            .foregroundStyle(.purple)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                Text(profile.repoUrl)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            // Quick stats
            HStack(spacing: 12) {
                if profile.networkEnabled {
                    statBadge(icon: "shield.checkered", label: profile.networkMode.label, color: .green)
                }
                if profile.hasGithubPat || profile.hasAdoPat {
                    statBadge(icon: "key.fill", label: profile.prProvider.label, color: .orange)
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
                .shadow(color: .black.opacity(isHovered ? 0.08 : 0.03), radius: isHovered ? 6 : 3, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .scaleEffect(isHovered ? 1.005 : 1.0)
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .onHover { isHovered = $0 }
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
        case .node22, .node22Pw:  "n.circle"
        case .dotnet9, .dotnet10: "d.circle"
        case .python312:          "p.circle"
        case .custom:             "gearshape"
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
        .frame(width: 700, height: 400)
}
