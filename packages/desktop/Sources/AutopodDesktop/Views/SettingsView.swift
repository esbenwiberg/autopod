import SwiftUI
import AutopodClient

/// App settings — connections and notification preferences.
public struct SettingsView: View {
  public let connectionManager: ConnectionManager
  @Binding public var isPresented: Bool

  public init(connectionManager: ConnectionManager, isPresented: Binding<Bool>) {
    self.connectionManager = connectionManager; self._isPresented = isPresented
  }

  @State private var showAddConnection = false

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

      TabView {
        connectionsTab
          .tabItem { Label("Connections", systemImage: "server.rack") }

        notificationsTab
          .tabItem { Label("Notifications", systemImage: "bell") }

        aboutTab
          .tabItem { Label("About", systemImage: "info.circle") }
      }
      .padding(16)
    }
    .frame(width: 480, height: 400)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  // MARK: - Connections

  private var connectionsTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      let connections = ConnectionStore.loadAll()

      if connections.isEmpty {
        Text("No saved connections")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.top, 20)
      } else {
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

      Spacer()
    }
  }

  // MARK: - Notifications

  @AppStorage("notify.escalation") private var notifyEscalation = true
  @AppStorage("notify.validation") private var notifyValidation = true
  @AppStorage("notify.failure") private var notifyFailure = true
  @AppStorage("notify.completion") private var notifyCompletion = true

  private var notificationsTab: some View {
    VStack(alignment: .leading, spacing: 12) {
      Toggle("Escalation (agent needs input)", isOn: $notifyEscalation)
      Toggle("Validation complete", isOn: $notifyValidation)
      Toggle("Session failed", isOn: $notifyFailure)
      Toggle("Session complete", isOn: $notifyCompletion)
      Spacer()
      Text("Notifications require macOS permission")
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
  }

  // MARK: - About

  private var aboutTab: some View {
    VStack(spacing: 12) {
      Image(systemName: "server.rack")
        .font(.system(size: 36))
        .foregroundStyle(.blue)
      Text("Autopod Desktop")
        .font(.title3.weight(.semibold))
      Text("Native macOS client for orchestrating Autopod sessions")
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      Spacer()
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 20)
  }
}
