import AppKit
import SwiftUI
import Testing
import AutopodDesktop
import AutopodUI

// Opt-in baseline: these desired-retention assertions intentionally fail on the
// unchanged production source. They must not silently run in unrelated suites.
@MainActor @Observable private final class ReplyBaselineInputs {
  var tab: DetailTab? = .overview
  var replySettled = false
}

@MainActor private struct ReplyBaselineHost: View {
  let fixture: PodStoreLifetimeFixture
  let actions: PodActions
  @Bindable var inputs: ReplyBaselineInputs
  var body: some View {
    if let pod = fixture.store.selectedSession {
      DetailPanelView(pod: pod, events: [], actions: actions, selectedTab: $inputs.tab)
    }
  }
}

@MainActor private func replySubviews(_ view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(replySubviews)
}

@MainActor private final class ReplyBaselineWindow {
  let inputs = ReplyBaselineInputs()
  let handler: ActionHandler
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let suite = "autopod-reply-baseline-\(UUID().uuidString)"
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let oldEnhanced: Any?

  init(_ fixture: PodStoreLifetimeFixture) {
    handler = ActionHandler(api: fixture.apiA, podStore: fixture.store, profileStore: ProfileStore())
    var actions = handler.actions
    let productionReply = actions.reply
    let inputs = inputs
    // Only retain/join the task. The native view calls the real handler action;
    // no text binding, submission logic, HTTP or outcome is replaced here.
    actions.reply = { id, text in
      let task = fixture.start { await productionReply(id, text) }
      _ = await task.value
      inputs.replySettled = true
    }
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    hosting = NSHostingView(rootView: AnyView(ReplyBaselineHost(fixture: fixture, actions: actions, inputs: inputs)
      .defaultAppStorage(UserDefaults(suiteName: suite)!)
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    hosting.appearance = NSAppearance(named: .darkAqua)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 760),
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

  var field: NSTextField? {
    window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); hosting.displayIfNeeded()
    return replySubviews(hosting).compactMap { $0 as? NSTextField }
      .first { $0.placeholderString == "Type your reply..." }
  }

  func wait(_ label: String, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !condition() {
      guard ContinuousClock.now < deadline else {
        print("REPLY_BASELINE timeout: \(label)")
        throw URLError(.timedOut)
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func type(_ text: String) async throws {
    try await wait("reply field mounted") { self.field != nil }
    let field = try #require(field)
    #expect(window.makeFirstResponder(field))
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    try await wait("native text binding") { field.stringValue == text }
    #expect(window.firstResponder === editor)
  }

  func nativeReturn() throws {
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, characters: "\r",
      charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    NSApplication.shared.sendEvent(event)
  }

  func capture(_ stage: String) throws {
    let text = field?.stringValue
    let editor = (window.firstResponder as? NSTextView)?.string
    print("REPLY_BASELINE \(stage) field=\(String(reflecting: text)) editor=\(String(reflecting: editor))")
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_REPLY_DRAFT_RENDER_DIR"] else { return }
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:]))
      .write(to: url.appendingPathComponent(stage + ".png"))
    try "field=\(String(reflecting: text))\neditor=\(String(reflecting: editor))\nframe=\(hosting.bounds)\n"
      .write(to: url.appendingPathComponent(stage + ".txt"), atomically: true, encoding: .utf8)
  }
}

private func replyRequestData(_ request: URLRequest) throws -> Data {
  if let body = request.httpBody { return body }
  let stream = try #require(request.httpBodyStream)
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 1024)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
    if count == 0 { break }
    data.append(contentsOf: buffer.prefix(count))
  }
  return data
}

@MainActor @Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["AUTOPOD_REPLY_DRAFT_BASELINE"] == "1"))
struct DecisionReplyDraftBaselineTests {
  @Test func nativeReplySurvivesOverviewUnmountAndRemount() async throws {
    try await withPodStoreLifetimeFixture { fixture in
      fixture.store.upsertSession(try decisionPod("A"))
      fixture.store.selectedSessionId = "decision"
      let view = ReplyBaselineWindow(fixture)
      defer { view.close() }
      let draft = "Keep synthetic draft R04f-remount-93a7"
      try await view.type(draft)
      let originalField = try #require(view.field)
      try view.capture("remount-before")
      view.inputs.tab = .logs
      try await view.wait("Overview unmounted") { view.field == nil }
      try view.capture("remount-away")
      view.inputs.tab = .overview
      try await view.wait("Overview remounted") { view.field != nil }
      #expect(view.field !== originalField)
      try view.capture("remount-after")
      #expect(view.field?.stringValue == draft)
      #expect(fixture.store.selectedSession?.escalationId == "A")
      #expect(fixture.a.requests.isEmpty && fixture.b.requests.isEmpty)
    }
  }

  @Test func nativeReturnRetainsReplyDuringHeldPostAndAfter500() async throws {
    try await withPodStoreLifetimeFixture { fixture in
      fixture.store.upsertSession(try decisionPod("A"))
      fixture.store.selectedSessionId = "decision"
      let view = ReplyBaselineWindow(fixture)
      defer { view.close() }
      let draft = "Keep synthetic draft R04f-post-58c2"
      try await view.type(draft)
      try view.capture("post-before-return")
      try view.nativeReturn()
      let request = try await fixture.a.next()
      #expect(request.request.httpMethod == "POST")
      #expect(request.request.url?.path == "/pods/decision/message")
      let body = try #require(JSONSerialization.jsonObject(with: replyRequestData(request.request)) as? [String: String])
      #expect(body == ["message": draft])
      #expect(fixture.a.activeCount == 1)
      #expect(!view.inputs.replySettled)
      try view.capture("post-held")
      #expect(view.field?.stringValue == draft)
      request.respond(status: 500, body: #"{"error":"Synthetic reply response failure"}"#)
      try await view.wait("real handler and owned task settled") { view.inputs.replySettled }
      #expect(view.handler.lastError != nil)
      #expect(view.handler.pendingAction == nil)
      try view.capture("post-after-500")
      #expect(view.field?.stringValue == draft)
      #expect(fixture.store.selectedSession?.escalationId == "A")
      #expect(fixture.store.selectedSession?.status == .awaitingInput)
      #expect(fixture.a.requests.count == 1 && fixture.b.requests.isEmpty)
    }
  }
}
