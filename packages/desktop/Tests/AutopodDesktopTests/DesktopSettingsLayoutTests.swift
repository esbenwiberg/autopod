import AppKit
import AutopodClient
import SwiftUI
import Testing

@testable import AutopodDesktop
@testable import AutopodUI

@MainActor @Test
func redesignedSettingsFitWorkspaceWithoutRestoringConnection() throws {
  let manager = ConnectionManager(restoreConnection: false)
  #expect(manager.state == .disconnected)
  #expect(manager.connection == nil)
  #expect(manager.activeToken == nil)
  let domain = "autopod-settings-layout-\(UUID().uuidString)"
  let defaults = try #require(UserDefaults(suiteName: domain))
  defaults.set(true, forKey: "autopod.desktop.redesign")
  defer { defaults.removePersistentDomain(forName: domain) }
  let output = ProcessInfo.processInfo.environment["AUTOPOD_SETTINGS_RENDER_DIR"]
  for route in DesktopSettingsRoute.allCases {
    let view = SettingsView(
      connectionManager: manager, profiles: [], isPresented: .constant(false),
      embedded: true, initialRoute: route
    ).defaultAppStorage(defaults)
    try renderSettingsView(
      view, width: 1250, height: 900,
      path: output.map { "\($0)/settings-\(route).png" })
  }
  if let output {
    let unavailable = DaemonError.badRequest("No daemon in native view renders")
    let actions = LaunchConfigurationActions(
      documents: DesktopConfigurationFixtures.documents,
      capabilities: .object([:]), reload: {}, resolve: { _ in throw unavailable },
      launch: { _ in throw unavailable }, save: { _, _ in throw unavailable },
      archive: { _ in throw unavailable }, discoverGitHubRepositories: { [] },
      discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { DesktopConfigurationFixtures.accounts },
      discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable })
    try renderSettingsView(
      ConfigurationLibraryView(actions: actions), width: 1550, height: 900,
      path: "\(output)/profiles-library.png")
    for kind in ConfigurationKind.allCases {
      let document = try #require(actions.list(kind).first)
      for area in ConfigurationEditorArea.areas(for: kind) {
        let view = ConfigurationEditorSheet(
          kind: kind, document: document, actions: actions,
          onClose: {}, onOpenDocument: { _ in }, initialArea: area
        )
        .environment(\.desktopOpenProviderAccounts, {})
        let file = area.rawValue.lowercased().replacingOccurrences(of: " ", with: "-")
        try renderSettingsView(
          view, width: 1500, height: 950,
          path: "\(output)/\(kind.rawValue)-\(file).png")
      }
    }
    try renderSettingsView(
      ConfigurationLibraryView(actions: actions), width: 900, height: 800,
      path: "\(output)/profiles-compact-light.png", light: true)
    try renderSettingsView(
      DesktopAppearanceSettings().defaultAppStorage(defaults), width: 1040,
      height: 820, path: "\(output)/appearance-light.png", light: true)
  }
}

@MainActor private func renderSettingsView<V: View>(
  _ view: V, width: Double, height: Double,
  path: String?, light: Bool = false
) throws {
  let hosting = NSHostingView(
    rootView: view.environment(\.desktopRedesign, true)
      .environment(\.controlActiveState, .key)
      .tint(DesktopTheme.accent).frame(width: width, height: height))
  let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: width, height: height),
    styleMask: [.titled], backing: .buffered, defer: false)
  window.contentView = hosting
  hosting.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
  window.layoutIfNeeded()
  hosting.layoutSubtreeIfNeeded()
  #expect(hosting.fittingSize.width <= width)
  #expect(hosting.fittingSize.height <= height)
  guard let path else { return }
  try FileManager.default.createDirectory(
    atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path,
    withIntermediateDirectories: true)
  let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
  hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
  let data = try #require(bitmap.representation(using: .png, properties: [:]))
  try data.write(to: URL(fileURLWithPath: path))
}
