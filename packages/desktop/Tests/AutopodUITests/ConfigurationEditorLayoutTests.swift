import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Test(arguments: ConfigurationKind.allCases)
func composableEditorFitsItsSheet(_ kind: ConfigurationKind) throws {
  let unavailable = DaemonError.badRequest("No daemon in the layout fixture")
  let actions = LaunchConfigurationActions(documents: [], capabilities: .object([:]), reload: {},
    resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
    save: { _, _ in throw unavailable }, archive: { _ in throw unavailable },
    discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
    loadProviderAccounts: { [] }, discoverPim: { throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  let view = ConfigurationEditorSheet(kind: kind, document: nil, actions: actions)
  let hosting = NSHostingView(rootView: view)
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 740), styleMask: [.titled], backing: .buffered, defer: false)
  window.contentView = hosting
  hosting.appearance = NSAppearance(named: .darkAqua)
  window.layoutIfNeeded()
  hosting.layoutSubtreeIfNeeded()
  #expect(hosting.fittingSize.width <= 760)
  #expect(hosting.fittingSize.height <= 740)
  // Optional owned-view rendering for local review; no screen or other application capture.
  if let directory = ProcessInfo.processInfo.environment["AUTOPOD_CONFIGURATION_RENDER_DIR"] {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    let data = try #require(bitmap.representation(using: .png, properties: [:]))
    try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(kind.rawValue).png"))
  }
}
