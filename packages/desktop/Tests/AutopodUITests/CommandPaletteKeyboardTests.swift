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

  func wait(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !condition() {
      guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func query(_ text: String) async throws {
    try await wait { paletteSubviews(self.hosting).contains { $0 is NSTextField } }
    let field = try #require(paletteSubviews(hosting).compactMap { $0 as? NSTextField }.first)
    #expect(window.makeFirstResponder(field))
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    try await wait { field.stringValue == text }
    #expect(window.firstResponder === editor)
  }

  func key(_ code: UInt16, characters: String = "\r") throws {
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
    NSApplication.shared.sendEvent(event)
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
