import AppKit
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Observable private final class PaletteInputs {
  var pods = [palettePod("a"), palettePod("b")]
  var profiles: [Profile] = []
  var presented = true
  var owner = PaletteOwner()
  var revision = 0
  var renderedRevision = -1
  var appearances = 0
}

@MainActor private final class PaletteOwner {
  var calls: [String] = []
  var actions: PodActions {
    var actions = PodActions.preview
    actions.approveAll = { self.calls.append("approve") }
    actions.killAllFailed = { self.calls.append("kill-failed") }
    return actions
  }
}

@MainActor private func palettePod(_ suffix: String) -> Pod {
  Pod(id: "recovery-" + suffix, status: .running, branch: "fix/recovery-" + suffix,
    profileName: "fixture", task: "Recover interrupted work", model: "fixture",
    startedAt: Date(timeIntervalSince1970: 0))
}

@MainActor private struct PaletteHost: View {
  @Bindable var inputs: PaletteInputs
  var body: some View {
    let owner = inputs.owner
    CommandPalette(isPresented: $inputs.presented, pods: inputs.pods, profiles: inputs.profiles,
      actions: owner.actions, onSelectSession: { owner.calls.append("pod:" + $0) },
      onCreatePod: { owner.calls.append("create") },
      onShowProfilePods: { owner.calls.append("profile:" + $0) },
      onEditProfile: { owner.calls.append("edit:" + $0) })
      .onAppear { inputs.appearances += 1; inputs.renderedRevision = inputs.revision }
      .onChange(of: inputs.revision) { _, revision in inputs.renderedRevision = revision }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .padding(20)
  }
}

@MainActor private func paletteAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}

@MainActor private func paletteNodes(_ node: NSObject) -> [NSObject] {
  [node] + (paletteAX(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(paletteNodes)
}

@MainActor private func paletteSubviews(_ view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(paletteSubviews)
}

@MainActor private final class PaletteWindow {
  let inputs = PaletteInputs()
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let suite = "autopod-palette-" + UUID().uuidString
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let oldEnhanced: Any?

  init() {
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    hosting = NSHostingView(rootView: AnyView(PaletteHost(inputs: inputs)
      .defaultAppStorage(UserDefaults(suiteName: suite)!)
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    hosting.appearance = NSAppearance(named: .darkAqua)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 400),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    window.makeKeyAndOrderFront(nil)
  }

  func close() {
    window.contentView = nil
    window.close()
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    NSApplication.shared.accessibilitySetValue(oldEnhanced ?? false, forAttribute: enhanced)
  }

  var texts: [String] {
    window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); hosting.displayIfNeeded()
    return paletteNodes(hosting).flatMap { node in
      ["accessibilityLabel", "accessibilityValue"].compactMap { paletteAX(node, $0) as? String }
    }
  }

  func wait(_ label: String = #function, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !condition() {
      guard ContinuousClock.now < deadline else { print("Timed out: \(label)"); throw URLError(.timedOut) }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func query(_ text: String) async throws {
    window.makeKeyAndOrderFront(nil)
    try await wait { paletteSubviews(self.hosting).contains { $0 is NSTextField } }
    let field = try #require(paletteSubviews(hosting).compactMap { $0 as? NSTextField }.first)
    #expect(window.makeFirstResponder(field))
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    try await wait { field.stringValue == text }
    #expect(window.firstResponder === editor)
  }

  func key(_ code: UInt16, characters: String = "\r", in target: NSWindow? = nil) throws {
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: (target ?? window).windowNumber, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
    NSApplication.shared.sendEvent(event)
  }

  func refresh() async throws {
    inputs.revision += 1
    try await wait { _ = self.texts; return self.inputs.renderedRevision == self.inputs.revision }
  }

  func bridge() throws -> CommandPaletteKeyboardView {
    try #require(paletteSubviews(hosting).compactMap { $0 as? CommandPaletteKeyboardView }.first)
  }

  func capture(_ name: String) throws {
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_PALETTE_RENDER_DIR"] else { return }
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    _ = texts
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent(name + ".png"))
    try (texts + ["calls=\(inputs.owner.calls)", "appearances=\(inputs.appearances)"])
      .joined(separator: "\n").write(to: url.appendingPathComponent(name + ".txt"), atomically: true, encoding: .utf8)
  }
}

@Suite(.serialized) @MainActor struct CommandPaletteKeyboardTests {
  @Test func nativeReturnUsesLiveRows() async throws {
    let view = PaletteWindow()
    defer { view.close() }
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-a") && view.texts.contains("fix/recovery-b") }
    try view.capture("rows-before")
    view.inputs.pods = [palettePod("b"), palettePod("c")]
    try await view.wait { !view.texts.contains("fix/recovery-a") && view.texts.contains("fix/recovery-c") }
    try view.capture("rows-after")
    try view.key(36)
    try await view.wait { !view.inputs.presented }
    #expect(view.inputs.owner.calls == ["pod:recovery-b"])
    #expect(view.inputs.appearances == 1)
    print("Native Return callback: \(view.inputs.owner.calls)")
    try view.capture("rows-activated")
  }
}


@MainActor private final class PaletteKeySink: NSView {
  var keys: [UInt16] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) { keys.append(event.keyCode) }
}

extension CommandPaletteKeyboardTests {
  @Test(arguments: ["pod", "profile", "approve"])
  func nativeSameRowsUseCurrentOwner(kind: String) async throws {
    let view = PaletteWindow()
    defer { view.close() }
    view.inputs.profiles = [Profile(name: "team", repoUrl: "https://example.invalid/old")]
    let query = kind == "pod" ? "recovery" : kind == "profile" ? "team" : "Approve All"
    try await view.query(query)
    let title = kind == "pod" ? "fix/recovery-a" : kind == "profile" ? "Show Pods for team" : "Approve All Validated"
    try await view.wait { view.texts.contains(title) }
    try view.capture("owner-" + kind + "-before")
    let oldOwner = view.inputs.owner
    view.inputs.owner = PaletteOwner()
    // Keep profile IDs and titles fixed while replacing the complete input value.
    view.inputs.profiles = [Profile(name: "team", repoUrl: "https://example.invalid/current")]
    try await view.refresh()
    if kind == "profile" {
      try await view.wait { view.texts.contains("https://example.invalid/current") }
    }
    try view.capture("owner-" + kind + "-after")
    try view.key(36)
    try await view.wait { !view.inputs.owner.calls.isEmpty }
    let expected = kind == "pod" ? "pod:recovery-a" : kind == "profile" ? "profile:team" : "approve"
    #expect(view.inputs.owner.calls == [expected])
    #expect(oldOwner.calls.isEmpty)
    #expect(view.inputs.appearances == 1)
    try view.capture("owner-" + kind + "-activated")
  }

  @Test func nativeArrowsUseCurrentCountAndQueryReset() async throws {
    let view = PaletteWindow()
    defer { view.close() }
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-b") }
    try view.key(125, characters: "\u{F701}") // Select B.
    view.inputs.pods = [palettePod("b")]
    try await view.wait { !view.texts.contains("fix/recovery-a") }
    view.inputs.pods = [palettePod("b"), palettePod("c"), palettePod("d")]
    try await view.wait { view.texts.contains("fix/recovery-d") }
    try view.key(126, characters: "\u{F700}") // Wrap from B to current last row D.
    try await view.refresh()
    try view.capture("arrows-current-last")
    try view.key(76, characters: "\u{3}")
    try await view.wait { !view.inputs.presented }
    #expect(view.inputs.owner.calls == ["pod:recovery-d"])

    view.inputs.presented = true
    view.inputs.pods = []
    try await view.wait { view.texts.contains("No results") }
    try view.key(125, characters: "\u{F701}")
    try view.key(126, characters: "\u{F700}")
    try view.key(36)
    #expect(view.inputs.presented)
    #expect(view.inputs.owner.calls == ["pod:recovery-d"])
    try view.capture("empty-results")

    view.inputs.pods = [palettePod("b"), palettePod("c"), palettePod("d")]
    try await view.wait { view.texts.contains("fix/recovery-d") }
    try view.key(125, characters: "\u{F701}") // Select C, then change query.
    // All three IDs remain: this requires query reset, not result-count clamping.
    try await view.query("interrupted")
    try await view.refresh()
    #expect(view.texts.contains("fix/recovery-c"))
    try view.key(36)
    try await view.wait { !view.inputs.presented }
    #expect(view.inputs.owner.calls == ["pod:recovery-d", "pod:recovery-b"])
    #expect(view.inputs.appearances == 1)
  }

  @Test(arguments: [UInt16(36), 76, 53])
  func nativeSupportedKeysExecuteOnce(code: UInt16) async throws {
    let view = PaletteWindow()
    defer { view.close() }
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-a") }
    try view.key(code, characters: code == 53 ? "\u{1b}" : code == 76 ? "\u{3}" : "\r")
    try view.key(36) // A second event before SwiftUI detaches must not re-execute.
    try await view.wait { !view.inputs.presented }
    #expect(view.inputs.owner.calls == (code == 53 ? [] : ["pod:recovery-a"]))
    try await view.wait { (try? view.bridge().isMonitoring) == false }
  }

  @Test func nativeWindowScopeAndRetainedClose() async throws {
    let view = PaletteWindow()
    defer { view.close() }
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-a") }
    let bridge = try view.bridge()
    #expect(bridge.isMonitoring)
    let sink = PaletteKeySink()
    let other = NSWindow(contentRect: NSRect(x: 600, y: 0, width: 160, height: 100),
      styleMask: [.titled], backing: .buffered, defer: false)
    other.isReleasedWhenClosed = false
    other.contentView = sink
    defer { other.contentView = nil; other.close() }
    other.makeKeyAndOrderFront(nil)
    #expect(other.makeFirstResponder(sink))
    for code: UInt16 in [125, 126, 36, 76, 53] { try view.key(code, in: other) }
    #expect(sink.keys == [125, 126, 36, 76, 53])
    #expect(view.inputs.owner.calls.isEmpty)
    #expect(view.inputs.presented)

    view.window.makeKeyAndOrderFront(nil)
    try await view.query("recovery")
    try view.key(6, characters: "z") // Unsupported key reaches the actual field editor.
    try await view.wait { view.texts.contains("No results") }
    #expect(view.inputs.owner.calls.isEmpty)
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-a") }
    view.window.close() // Content deliberately retained: this is not a detach test.
    #expect(view.window.contentView === view.hosting)
    #expect(!bridge.isMonitoring)
    other.makeKeyAndOrderFront(nil)
    #expect(other.makeFirstResponder(sink))
    try view.key(36, in: other)
    #expect(sink.keys == [125, 126, 36, 76, 53, 36])
    #expect(view.inputs.owner.calls.isEmpty)
    #expect(view.inputs.presented)
    view.window.makeKeyAndOrderFront(nil)
    view.window.update()
    try await view.wait("reopened monitor visible=\(view.window.isVisible) key=\(view.window.isKeyWindow)") { bridge.isMonitoring }
    try await view.query("recovery")
    try view.key(125, characters: "\u{F701}")
    try view.key(36)
    try await view.wait { !view.inputs.presented }
    #expect(view.inputs.owner.calls == ["pod:recovery-b"])
  }

  @Test func nativeDetachDismantleAndReopen() async throws {
    let view = PaletteWindow()
    defer { view.close() }
    try await view.query("recovery")
    try await view.wait { view.texts.contains("fix/recovery-a") }
    let bridge = try view.bridge()
    view.window.contentView = nil
    #expect(!bridge.isMonitoring)
    #expect(bridge.window == nil)
    view.window.contentView = view.hosting
    try await view.wait("reopened monitor visible=\(view.window.isVisible) key=\(view.window.isKeyWindow)") { bridge.isMonitoring }
    try await view.query("recovery")
    try view.key(125, characters: "\u{F701}")
    try view.key(36)
    try await view.wait("keyboard activation") { !view.inputs.presented }
    #expect(view.inputs.owner.calls == ["pod:recovery-b"])
    view.inputs.presented = true
    try await view.refresh()
    try await view.wait { bridge.isMonitoring }
    view.hosting.rootView = AnyView(EmptyView())
    try await view.wait { _ = view.texts; return !bridge.isMonitoring }
    bridge.dispose()
    bridge.dispose() // Explicit teardown is idempotent after native dismantling.
    #expect(!bridge.isMonitoring)
  }
}


extension CommandPaletteKeyboardTests {
  @Test func bridgeReleasesReplacedAndDisposedCallbacks() {
    let bridge = CommandPaletteKeyboardView()
    var owner: PaletteOwner? = PaletteOwner()
    weak var oldOwner = owner
    bridge.update(isPresented: true) { [captured = owner!] _ in
      captured.calls.append("old"); return true
    }
    owner = nil
    #expect(oldOwner != nil)
    bridge.update(isPresented: true) { _ in true }
    #expect(oldOwner == nil)
    var current: PaletteOwner? = PaletteOwner()
    weak var releasedOnDispose = current
    bridge.update(isPresented: true) { [captured = current!] _ in
      captured.calls.append("current"); return true
    }
    current = nil
    #expect(releasedOnDispose != nil)
    bridge.dispose()
    bridge.dispose()
    #expect(releasedOnDispose == nil)
  }
}
