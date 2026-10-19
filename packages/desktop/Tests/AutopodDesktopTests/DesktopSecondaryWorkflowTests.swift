import AppKit
import AutopodClient
import SwiftUI
import Testing

@testable import AutopodDesktop
@testable import AutopodUI

@Suite(.serialized) @MainActor struct DesktopSecondaryWorkflowTests {
  @Test(arguments: [false, true])
  func secondaryDialogsUseDesktopChromeAndFitTheirBounds(light: Bool) async throws {
    NSApplication.shared.finishLaunching()
    let provider = try secondaryProvider()
    let actions = try secondaryActions()
    let watcher = try secondaryWatcher()
    let pim = try secondaryPim()
    let views: [(String, AnyView, CGFloat, CGFloat)] = [
      (
        "provider-create",
        AnyView(
          ProviderAccountCreateSheet(isPresented: .constant(true), providers: [provider]) {
            _, _, _, _ in
          }), 680, 650
      ),
      (
        "provider-api-key",
        AnyView(
          ProviderAPIKeySheet(
            isPresented: .constant(true), accountName: "Fixture account", provider: provider
          ) { _ in }), 680, 440
      ),
      (
        "provider-foundry",
        AnyView(
          FoundryCredentialsSheet(isPresented: .constant(true), accountName: "Fixture Foundry") {
            _ in
          }), 680, 650
      ),
      (
        "provider-import",
        AnyView(
          ProviderAccountImportSheet(isPresented: .constant(true), profiles: [MockProfiles.all[0]])
          { _, _, _, _ in }), 680, 550
      ),
      (
        "connection-setup",
        AnyView(
          SetupSheet(
            isPresented: .constant(true),
            connectionManager: ConnectionManager(restoreConnection: false))), 680, 590
      ),
      ("watcher-create", AnyView(WatcherEditorView(actions: actions, item: nil)), 820, 740),
      ("watcher-edit", AnyView(WatcherEditorView(actions: actions, item: watcher)), 820, 740),
      (
        "pim-selected",
        AnyView(
          PimSelectionSheet(
            selected: pim.selected, cached: pim.discovery, discover: { _ in pim.discovery },
            onSave: { _ in })), 820, 740
      ),
      (
        "pim-empty",
        AnyView(
          PimSelectionSheet(
            selected: [], cached: .object(["families": .array([])]),
            discover: { _ in .object(["families": .array([])]) }, onSave: { _ in })), 820, 740
      ),
      (
        "pim-error",
        AnyView(
          PimSelectionSheet(
            selected: pim.selected, discover: { _ in throw URLError(.notConnectedToInternet) },
            onSave: { _ in })), 820, 740
      ),
      (
        "analysis-history", AnyView(AnalysisWorkspaceSheet(kind: "history", actions: actions)), 900,
        800
      ),
      (
        "analysis-memory", AnyView(AnalysisWorkspaceSheet(kind: "memory", actions: actions)), 900,
        800
      ),
      (
        "analysis-configuration",
        AnyView(
          AnalysisWorkspaceSheet(
            kind: "history", actions: actions,
            initialSelection: ["repositoryId": .string("repo-backend")], initialStage: .configure)),
        900, 800
      ),
      (
        "command-palette",
        AnyView(CommandPalette(isPresented: .constant(true), pods: MockData.all)), 600, 440
      ),
    ]
    for (name, view, width, height) in views {
      let host = SecondaryHost(view, width: width, height: height, light: light)
      try await host.settle()
      #expect(host.hosting.fittingSize.width <= width, "\(name) width")
      #expect(host.hosting.fittingSize.height <= height, "\(name) height")
      if name != "command-palette" && name != "connection-setup" && !name.hasPrefix("analysis-") {
        #expect(host.has("desktop-secondary-dialog"), "\(name) has themed chrome")
      }
      if name == "watcher-create" {
        #expect(host.enabled("Cancel"))
        #expect(!host.enabled("Save"))
      }
      if name == "provider-create" { #expect(!host.enabled("Create")) }
      if name == "provider-api-key" { #expect(!host.enabled("Save")) }
      if name == "pim-selected" { #expect(host.enabled("Use selections")) }
      if name == "pim-error" { #expect(host.contains("could not be verified")) }
      try host.capture(name + (light ? "-light" : "-dark"))
      host.close()
    }
  }

  @Test(arguments: [false, true])
  func secondaryWorkspacesRenderPopulatedAndUnavailableStates(light: Bool) async throws {
    NSApplication.shared.finishLaunching()
    let actions = try secondaryActions()
    let api = secondaryAPI()
    let views: [(String, AnyView)] = [
      ("watchers", AnyView(WatcherLibraryView(actions: actions))),
      ("deployments", AnyView(DeploymentLibraryView(actions: actions))),
      (
        "provider-accounts",
        AnyView(ProviderAccountsSettingsView(api: api, profiles: [], onProfilesChanged: nil))
      ),
      (
        "podsitter",
        AnyView(
          PodsitterSettingsView(
            api: MockPodsitterAPI(), profileNames: ["autopod-self"], openProviderAccounts: {}))
      ),
    ]
    for width in [CGFloat(900), CGFloat(1250)] {
      for (name, view) in views {
        let host = SecondaryHost(view, width: width, height: 900, light: light)
        try await host.settle()
        #expect(host.hosting.fittingSize.width <= width)
        #expect(host.hosting.fittingSize.height <= 900)
        try host.capture("\(name)-\(Int(width))-\(light ? "light" : "dark")")
        host.close()
      }
    }
    var unavailable = actions
    unavailable.listWatchers = { throw DaemonError.badRequest("Watcher fixture is offline") }
    let host = SecondaryHost(
      WatcherLibraryView(actions: unavailable), width: 900, height: 700, light: light)
    try await host.settle()
    #expect(host.contains("Watcher fixture is offline"))
    try host.capture("watchers-error-\(light)")
    host.close()
  }

  @Test(arguments: ["nudge", "reject", "force-complete", "kick", "handoff", "single-spec"])
  func podControlSheetsKeepThemedPresentationAndCancel(control: String) async throws {
    NSApplication.shared.finishLaunching()
    let pod = MockData.all[0]
    let host = SecondaryHost(
      DetailPanelView(pod: pod, controlDialog: control), width: 1100, height: 850)
    try await host.wait { host.window.attachedSheet != nil && host.has("desktop-secondary-dialog") }
    #expect(host.enabled("Cancel"))
    try host.capture("pod-" + control)
    try host.press("Cancel")
    try await host.wait { host.window.attachedSheet == nil }
    host.close()
  }

  @Test func deploymentApprovalRetainsTheReviewedDigestAndReconciliationCanCancel() async throws {
    NSApplication.shared.finishLaunching()
    var actions = try secondaryActions()
    var observed: [ConfigurationJSON] = []
    actions.decideDeployment = { _, value in
      observed.append(value)
      return .object([:])
    }
    let review = try secondaryReview()
    let host = SecondaryHost(
      DeploymentLibraryView(actions: actions, review: review), width: 1100, height: 850)
    try await host.wait { host.window.attachedSheet != nil && host.has("desktop-secondary-dialog") }
    try host.capture("deployment-review")
    try host.press("Approve this commit and deploy")
    try await host.wait { !observed.isEmpty }
    #expect(observed[0]["digest"] == review["run"]?["digest"])
    #expect(observed[0]["decision"] == .string("approve"))
    host.close()
    let reconcile = SecondaryHost(
      DeploymentLibraryView(actions: actions, uncertain: review["run"]), width: 1100, height: 850)
    try await reconcile.wait { reconcile.window.attachedSheet != nil }
    #expect(reconcile.enabled("Cancel"))
    #expect(!reconcile.enabled("Record outcome and release target"))
    try reconcile.capture("deployment-reconcile")
    try reconcile.press("Cancel")
    try await reconcile.wait { reconcile.window.attachedSheet == nil }
    reconcile.close()
  }

  @Test(arguments: ["history", "memory"], [false, true])
  func analysisComposerKeepsTaskSemanticsAndInvalidatesEditedReviews(kind: String, empty: Bool)
    async throws
  {
    NSApplication.shared.finishLaunching()
    var actions = try secondaryActions()
    var resolved: [ComposableLaunchRequest] = []
    var launched: [ComposableLaunchRequest] = []
    actions.resolve = { value in
      resolved.append(value)
      return try JSONDecoder().decode(
        EffectiveLaunchPreview.self,
        from: Data(
          #"{"digest":"reviewed-analysis-digest","repository":{"config":{"remote":"https://github.com/acme/autopod.git"}},"resolvedExecution":{"target":"local"},"ai":{"main":{"model":"fixture-model"}}}"#
            .utf8))
    }
    actions.launch = { value in
      launched.append(value)
      return "analysis-fixture"
    }
    var selection: [String: ConfigurationJSON] = ["profileId": .string("profile-backend")]
    if empty {
      selection["emptyWorkspace"] = .bool(true)
    } else {
      selection["repositoryId"] = .string("repo-backend")
    }
    let host = SecondaryHost(
      AnalysisWorkspaceSheet(kind: kind, actions: actions, initialSelection: selection),
      width: 1280, height: 850)
    defer { host.close() }
    try await host.wait { host.enabled("Preview workspace") }
    #expect(!host.enabled("Launch workspace"))
    try host.press("Preview workspace")
    try await host.wait { host.enabled("Launch workspace") }
    #expect(resolved[0].intent == "task")
    #expect(resolved[0].overrides?.workflow?["agentMode"] == .string("interactive"))
    #expect(resolved[0].overrides?.workflow?["output"] == .string(empty ? "artifact" : "branch"))
    #expect(resolved[0].overrides?.workflow?["validationPhases"] == .array([]))
    try host.capture("analysis-\(kind)-review-\(empty)")
    if kind == "history" {
      try host.pressID("launch-stage-0")
      try await host.wait { host.enabled("Failures only") }
      try host.press("Failures only")
      try await host.wait { !host.enabled("Launch workspace") }
      try host.press("Preview workspace")
      try await host.wait { host.enabled("Launch workspace") }
      #expect(resolved.last?.work?["analysis"]?["failuresOnly"] == .bool(true))
    }
    try host.press("Launch workspace")
    try await host.wait { !launched.isEmpty }
    #expect(launched[0].expectedDigest == "reviewed-analysis-digest")
    #expect(launched[0].requestId?.isEmpty == false)
    #expect(launched[0].emptyWorkspace == (empty ? true : nil))
  }

  @Test func legacyDialogPresentationRemainsAvailable() async throws {
    let host = SecondaryHost(
      WatcherEditorView(actions: try secondaryActions(), item: nil), width: 720, height: 620,
      redesign: false)
    try await host.settle()
    #expect(!host.has("desktop-secondary-dialog"))
    #expect(host.enabled("Cancel"))
    host.close()
  }
}

@MainActor private final class SecondaryHost {
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  init<V: View>(
    _ view: V, width: CGFloat, height: CGFloat, light: Bool = false, redesign: Bool = true
  ) {
    NSApplication.shared.accessibilitySetValue(
      true, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
    hosting = NSHostingView(
      rootView: AnyView(
        view.environment(\.desktopRedesign, redesign)
          .environment(\.colorScheme, light ? .light : .dark).environment(
            \.controlActiveState, .key
          )
          .transaction { $0.disablesAnimations = true }.frame(width: width, height: height)))
    hosting.sizingOptions = []
    hosting.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    window.orderFront(nil)
  }
  func close() {
    if let sheet = window.attachedSheet { window.endSheet(sheet) }
    window.contentView = nil
    window.close()
  }
  var target: NSView { window.attachedSheet?.contentView ?? hosting }
  var nodes: [NSObject] {
    window.layoutIfNeeded()
    target.layoutSubtreeIfNeeded()
    return secondaryNodes(target)
  }
  func has(_ id: String) -> Bool {
    nodes.contains { secondaryAX($0, "accessibilityIdentifier") as? String == id }
  }
  func contains(_ text: String) -> Bool {
    nodes.contains {
      (secondaryAX($0, "accessibilityLabel") as? String ?? "").contains(text)
        || (secondaryAX($0, "accessibilityValue") as? String ?? "").contains(text)
    }
  }
  func enabled(_ label: String) -> Bool {
    nodes.contains {
      secondaryAX($0, "accessibilityLabel") as? String == label
        && secondaryAX($0, "accessibilityEnabled") as? Bool == true
    }
  }
  func pressID(_ id: String) throws {
    let node = try #require(
      nodes.first {
        secondaryAX($0, "accessibilityIdentifier") as? String == id
          && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
      })
    _ = secondaryAX(node, "accessibilityPerformPress")
  }
  func press(_ label: String) throws {
    let node = try #require(
      nodes.first {
        secondaryAX($0, "accessibilityLabel") as? String == label
          && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
      })
    #expect(secondaryAX(node, "accessibilityEnabled") as? Bool == true)
    _ = secondaryAX(node, "accessibilityPerformPress")
  }
  func settle() async throws {
    try await Task.sleep(for: .milliseconds(150))
    _ = nodes
  }
  func wait(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !condition() {
      guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
      try await Task.sleep(for: .milliseconds(20))
    }
  }
  func capture(_ name: String) throws {
    guard let output = ProcessInfo.processInfo.environment["AUTOPOD_SECONDARY_RENDER_DIR"] else {
      return
    }
    _ = nodes
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
    let bitmap = try #require(target.bitmapImageRepForCachingDisplay(in: target.bounds))
    target.cacheDisplay(in: target.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(
      to: URL(fileURLWithPath: output).appendingPathComponent(name + ".png"))
  }
}

@MainActor private func secondaryAX(_ node: NSObject, _ key: String) -> Any? {
  guard
    node.responds(to: NSSelectorFromString(key))
      || node.responds(
        to: NSSelectorFromString("is" + key.prefix(1).uppercased() + key.dropFirst()))
  else { return nil }
  return node.value(forKey: key)
}
@MainActor private func secondaryNodes(_ node: NSObject) -> [NSObject] {
  [node] + (secondaryAX(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(secondaryNodes)
}

@MainActor private func secondaryActions() throws -> LaunchConfigurationActions {
  let unavailable = URLError(.notConnectedToInternet)
  let watcher = try secondaryWatcher()
  var result = LaunchConfigurationActions(
    documents: DesktopConfigurationFixtures.documents, capabilities: .object([:]), reload: {},
    resolve: { _ in throw unavailable }, launch: { _ in throw unavailable },
    save: { _, _ in throw unavailable }, archive: { _ in },
    discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] },
    loadProviderAccounts: { [] },
    discoverPim: { _ in throw unavailable }, saveFromLaunch: { _ in throw unavailable },
    listWatchers: { [watcher] }, saveWatcher: { _ in watcher })
  let run = try secondaryReview()["run"]!
  result.listDeployments = { [run] }
  return result
}
private func secondaryProvider() throws -> ProviderCatalogProvider {
  try JSONDecoder().decode(
    ProviderCatalogProvider.self,
    from: Data(
      ##"{"id":"fixture","displayName":"Fixture Cloud","description":"Offline fixture","implementation":{"kind":"generic-pi-api","piProviderId":"fixture"},"credentialOptions":[{"kind":"api-key","label":"API key","acquisition":"Create a key in the provider account."}],"modelIds":[],"requiredHosts":[],"policy":{"lifecycle":"active","authorization":"supported","runnable":true,"caveats":[]}}"##
        .utf8))
}
private func secondaryWatcher() throws -> WatcherBindingResponse {
  try JSONDecoder().decode(
    WatcherBindingResponse.self,
    from: Data(
      ##"{"id":"watcher","revision":3,"ownerUserId":"fixture","createdAt":"2026-10-19T00:00:00Z","updatedAt":"2026-10-19T00:00:00Z","payload":{"name":"Review incoming issues","enabled":true,"labelPrefix":"autopod","launch":{"repositoryId":"repo-backend","profileId":"profile-backend"},"targets":{"artifact":{"profileId":"profile-backend"}}}}"##
        .utf8))
}
private func secondaryReview() throws -> ConfigurationJSON {
  try JSONDecoder().decode(
    ConfigurationJSON.self,
    from: Data(
      ##"{"run":{"id":"deployment","state":"awaiting_approval","digest":"reviewed-digest","plan":{"repositoryId":"fixture/repo","targetId":"staging","sourceBranch":"main","sourceCommit":"aabbccddeeff00112233445566778899aabbccdd","podId":"fixture-pod","scriptPath":"scripts/deploy.sh","args":["--staging"]}},"scriptContent":"#!/bin/sh\nset -eu\necho 'Offline deployment fixture'\n","target":{"name":"Staging"}}"##
        .utf8))
}
private func secondaryPim() throws -> (
  selected: [[String: ConfigurationJSON]], discovery: ConfigurationJSON
) {
  let entry = try JSONDecoder().decode(
    ConfigurationJSON.self,
    from: Data(
      ##"{"type":"azure","tenantId":"fixture","principalId":"fixture","eligibilityId":"eligible-reader","roleId":"reader","scope":"/subscriptions/fixture","displayName":"Reader","scopeName":"Fixture subscription","maximumDurationMinutes":120}"##
        .utf8))
  var selected = entry.object!
  selected["duration"] = .string("PT1H")
  selected["justification"] = .string("Inspect the deployment evidence")
  selected["timing"] = .string("when-needed")
  return (
    [selected],
    .object([
      "families": .array([
        .object([
          "type": .string("azure"), "available": .bool(true), "assignments": .array([entry]),
        ])
      ])
    ])
  )
}

private func secondaryAPI() -> DaemonAPI {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [SecondaryProviderProtocol.self]
  return DaemonAPI(
    baseURL: URL(string: "https://secondary-fixture.invalid")!, token: "offline-fixture",
    session: URLSession(configuration: config))
}
private final class SecondaryProviderProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "secondary-fixture.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let json =
      request.url?.path == "/provider-accounts"
      ? MockPodsitterAPI.accountsJSON : MockPodsitterAPI.catalogJSON
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(json.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
