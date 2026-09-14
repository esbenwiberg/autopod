import AppKit
import AutopodClient
import AutopodUI
import SwiftUI

/// Local interaction fixture. No daemon connection, credentials or durable storage.
@main
struct ConfigurationPreviewApp: App {
  @State private var documents: [ConfigurationDocument] = []
  @State private var saved = "Edits stay in this preview window."
  var body: some Scene {
    Window("AutoPod Configuration Preview", id: "configuration-preview") {
      VStack(spacing: 0) {
        HStack { Text("Local preview").bold(); Text(saved); Spacer() }.padding(12).background(.yellow.opacity(0.12))
        ConfigurationLibraryView(actions: actions)
      }.frame(minWidth: 1050, minHeight: 780)
        .task { NSApplication.shared.setActivationPolicy(.regular); NSApplication.shared.activate(ignoringOtherApps: true) }
    }.defaultSize(width: 1100, height: 820)
  }
  private var actions: LaunchConfigurationActions {
    LaunchConfigurationActions(documents: documents, capabilities: .object([:]), reload: {},
      resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
      save: { kind, request in
        // Exercise the native editing flow only. Schema validation belongs to daemon tests.
        let id = request.id ?? UUID().uuidString
        let object: ConfigurationJSON = .object([
          "id": .string(id), "kind": .string(kind.rawValue), "name": .string(request.name),
          "revision": .number(Double((request.expectedRevision ?? 0) + 1)),
          "createdAt": .string("2026-09-14T00:00:00Z"), "updatedAt": .string("2026-09-14T00:00:00Z"),
          "archived": .bool(false), "payload": .object(request.payload),
        ])
        let document = try JSONDecoder().decode(ConfigurationDocument.self, from: Data(object.formatted().utf8))
        documents.removeAll { $0.id == id }; documents.append(document)
        saved = "Saved \(request.name) in memory."
        return document
      },
      archive: { document in documents.removeAll { $0.id == document.id } },
      discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
      loadProviderAccounts: { [] }, discoverPim: { throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  }
  private var unavailable: DaemonError { .badRequest("This local preview has no daemon or provider connection.") }
}
