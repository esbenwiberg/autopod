import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Test(arguments: ConfigurationKind.allCases, [false, true])
func composableEditorFitsItsSheet(_ kind: ConfigurationKind, populated: Bool) throws {
  let unavailable = DaemonError.badRequest("No daemon in the layout fixture")
  let actions = LaunchConfigurationActions(documents: [], capabilities: .object([:]), reload: {},
    resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
    save: { _, _ in throw unavailable }, archive: { _ in throw unavailable },
    discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
    loadProviderAccounts: { [] }, discoverPim: { throw unavailable }, saveFromLaunch: { _ in throw unavailable })
  let document = populated ? try configurationEditorFixture(kind) : nil
  let view = ConfigurationEditorSheet(kind: kind, document: document, actions: actions)
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
    try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(kind.rawValue)\(populated ? "-populated" : "").png"))
  }
}

private func configurationEditorFixture(_ kind: ConfigurationKind) throws -> ConfigurationDocument {
  let route: ConfigurationJSON = .object(["providerAccountId": .string("account"), "runtime": .string("codex"), "model": .string("gpt-5.6-sol"), "reasoningEffort": .string("medium"), "maxHops": .number(0), "failover": .array([])])
  let payload: [String: ConfigurationJSON]
  switch kind {
  case .workflow:
    payload = ["agentMode": .string("auto"), "intent": .string("task"), "output": .string("pr"), "completion": .string("approval"), "validationPhases": .array(["setup", "build", "test", "review"].map(ConfigurationJSON.string)), "tokenBudget": .null, "reviewerTokenBudget": .null, "agentDonePrompt": .null, "maxValidationAttempts": .number(3), "mergePollIntervalSec": .number(60), "maxBudgetExtensions": .null, "tokenBudgetWarnAt": .number(0.8)]
  case .ai: payload = ["main": route, "reviewer": .object(["mode": .string("follow-main")])]
  case .environment: payload = ["template": .string("node22"), "baseImage": .null, "tools": .array([.object(["name": .string("pnpm"), "version": .string("10.0.0")])]), "capabilities": .array([.string("node"), .string("custom-capability")]), "sidecars": .array([])]
  case .repository: payload = ["provider": .string("ado"), "remote": .string("https://dev.azure.com/365projectum/TeamPlanner%20-%20V3/_git/TeamPlanner"), "defaultSetupId": .string("default"), "setups": .array([.object(["id": .string("default"), "name": .string("Application"), "defaultBranch": .string("main"), "buildCommand": .string("npm run build")]), .object(["id": .string("other"), "name": .string("Tests"), "defaultBranch": .string("main")])])]
  case .githubAccess: payload = ["rules": .array([.object(["id": .string("read"), "repositories": .object(["mode": .string("selected"), "repositoryIds": .array([.string("unavailable-repo")])]), "operations": .array([.string("code.read")])])])]
  default: payload = [:]
  }
  let value: ConfigurationJSON = .object(["id": .string("fixture"), "kind": .string(kind.rawValue), "name": .string(kind == .repository ? "https://dev.azure.com/365projectum/TeamPlanner%20-%20V3/_git/TeamPlanner" : "Example preset"), "revision": .number(1), "createdAt": .string("2026-09-14T00:00:00Z"), "updatedAt": .string("2026-09-14T00:00:00Z"), "archived": .bool(false), "payload": .object(payload)])
  return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(value.formatted().utf8))
}

@Test func repositoryShortTitlePreservesSourceIdentity() throws {
  let document = try configurationEditorFixture(.repository)
  #expect(document.libraryTitle == "TeamPlanner")
  #expect(document.name.hasPrefix("https://dev.azure.com/"))
  #expect(document.payload["remote"]?.string == document.name)
}

@MainActor @Test func repositoryDropdownStaysCompactWithHundredsOfRepositories() {
  let repositories: [ConfigurationJSON] = (0..<500).map { index in
    .object(["id": .string("\(index)"), "ownerLogin": .string("organization"), "name": .string("repository-\(index)")])
  }
  let view = RepositoryMultiSelect(repositories: repositories,
    selectedIDs: .constant((0..<300).map { "\($0)" }), loading: false, refresh: {})
  let hosting = NSHostingView(rootView: view.frame(width: 600))
  hosting.layoutSubtreeIfNeeded()
  #expect(hosting.fittingSize.width <= 600)
  #expect(hosting.fittingSize.height < 70)
}
