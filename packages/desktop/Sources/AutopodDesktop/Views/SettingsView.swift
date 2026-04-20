import SwiftUI
import AutopodClient
import AutopodUI

// MARK: - Settings sections

enum SettingsSection: Hashable {
    case connections
    case profiles
    case notifications
    case about

    var label: String {
        switch self {
        case .connections:   "Connections"
        case .profiles:      "Profiles"
        case .notifications: "Notifications"
        case .about:         "About"
        }
    }

    var icon: String {
        switch self {
        case .connections:   "server.rack"
        case .profiles:      "person.crop.rectangle.stack"
        case .notifications: "bell"
        case .about:         "info.circle"
        }
    }
}

// MARK: - Settings view

/// App settings — sidebar-based layout with connections, profiles, notifications, and about.
public struct SettingsView: View {
    public let connectionManager: ConnectionManager
    public let profiles: [Profile]
    public let actionCatalog: [ActionCatalogItem]
    public let profileError: String?
    public var onSaveProfile: ((Profile) async throws -> Void)?
    public var onCreateProfile: ((Profile) async throws -> Void)?
    public var onAuthenticateProfile: ProfileAuthHandler?
    public var onLoadProfileEditor: ((String) async throws -> ProfileEditorResponse)?
    public var onSaveProfileWithInheritance: (
        (Profile, Set<String>, Set<String>, [String: MergeMode]) async throws -> Void
    )?
    @Binding public var isPresented: Bool

    public init(connectionManager: ConnectionManager, profiles: [Profile],
                actionCatalog: [ActionCatalogItem] = [],
                profileError: String? = nil,
                onSaveProfile: ((Profile) async throws -> Void)? = nil, onCreateProfile: ((Profile) async throws -> Void)? = nil,
                onAuthenticateProfile: ProfileAuthHandler? = nil,
                onLoadProfileEditor: ((String) async throws -> ProfileEditorResponse)? = nil,
                onSaveProfileWithInheritance: (
                    (Profile, Set<String>, Set<String>, [String: MergeMode]) async throws -> Void
                )? = nil,
                isPresented: Binding<Bool>) {
        self.connectionManager = connectionManager
        self.profiles = profiles
        self.actionCatalog = actionCatalog
        self.profileError = profileError
        self.onSaveProfile = onSaveProfile
        self.onCreateProfile = onCreateProfile
        self.onAuthenticateProfile = onAuthenticateProfile
        self.onLoadProfileEditor = onLoadProfileEditor
        self.onSaveProfileWithInheritance = onSaveProfileWithInheritance
        self._isPresented = isPresented
    }

    @State private var selectedSection: SettingsSection = .profiles

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Settings")
                    .font(.headline)
                Spacer()
                Button { isPresented = false } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                        .font(.title3)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            Divider()

            // Sidebar + Content
            HStack(spacing: 0) {
                settingsSidebar
                Divider()
                settingsContent
            }
        }
        .frame(width: 720, height: 500)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Sidebar

    private var settingsSidebar: some View {
        VStack(spacing: 1) {
            ForEach([SettingsSection.connections, .profiles, .notifications], id: \.self) { section in
                sidebarRow(section)
            }
            Spacer()
            sidebarRow(.about)
        }
        .padding(10)
        .frame(width: 160)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    private func sidebarRow(_ section: SettingsSection) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) {
                selectedSection = section
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

    // MARK: - Content

    @ViewBuilder
    private var settingsContent: some View {
        switch selectedSection {
        case .connections:   connectionsContent
        case .profiles:      profilesContent
        case .notifications: notificationsContent
        case .about:         aboutContent
        }
    }

    // MARK: - Connections

    private var connectionsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connections")
                .font(.title3.weight(.semibold))
            Text("Saved daemon connections.")
                .font(.callout)
                .foregroundStyle(.secondary)

            let connections = ConnectionStore.loadAll()

            if connections.isEmpty {
                Spacer()
                Text("No saved connections")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                Spacer()
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(connections) { conn in
                            HStack {
                                Circle()
                                    .fill(connectionManager.connection?.id == conn.id && connectionManager.isConnected ? .green : .secondary)
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(conn.name)
                                        .font(.callout.weight(.medium))
                                    Text(conn.label)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if connectionManager.connection?.id == conn.id {
                                    Text("Active")
                                        .font(.caption2)
                                        .foregroundStyle(.green)
                                }
                                Button {
                                    connectionManager.removeConnection(conn.id)
                                } label: {
                                    Image(systemName: "trash")
                                        .foregroundStyle(.red.opacity(0.6))
                                }
                                .buttonStyle(.borderless)
                            }
                            .padding(10)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                Spacer()
            }
        }
        .padding(20)
    }

    // MARK: - Profiles

    private var profilesContent: some View {
        VStack(spacing: 0) {
            if let profileError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                    Text(profileError)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color.red.opacity(0.08))
            }
            ProfileListView(profiles: profiles, actionCatalog: actionCatalog,
                           onSave: onSaveProfile, onCreate: onCreateProfile,
                           onAuthenticate: onAuthenticateProfile,
                           onLoadEditor: onLoadProfileEditor,
                           onSaveWithInheritance: onSaveProfileWithInheritance)
        }
    }

    // MARK: - Notifications

    @AppStorage("notify.escalation") private var notifyEscalation = true
    @AppStorage("notify.validation") private var notifyValidation = true
    @AppStorage("notify.failure") private var notifyFailure = true
    @AppStorage("notify.completion") private var notifyCompletion = true

    private var notificationsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Notifications")
                .font(.title3.weight(.semibold))
            Text("Control which events trigger macOS notifications.")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 10) {
                Toggle("Escalation (agent needs input)", isOn: $notifyEscalation)
                Toggle("Validation complete", isOn: $notifyValidation)
                Toggle("Pod failed", isOn: $notifyFailure)
                Toggle("Pod complete", isOn: $notifyCompletion)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
            )

            Spacer()

            Text("Notifications require macOS permission in System Settings.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(20)
    }

    // MARK: - About

    private var aboutContent: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "server.rack")
                .font(.system(size: 36))
                .foregroundStyle(.blue)
            Text("Autopod Desktop")
                .font(.title3.weight(.semibold))
            Text("Native macOS client for orchestrating Autopod pods.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(20)
    }
}
