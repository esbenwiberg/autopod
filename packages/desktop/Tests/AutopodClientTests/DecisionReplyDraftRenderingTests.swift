import AppKit
import SwiftUI
import Testing
import AutopodDesktop
@testable import AutopodUI

// Native regressions converted from the strict failing baseline at bc846039.
@MainActor @Observable private final class ReplyDraftInputs {
  var tab: DetailTab? = .overview
  var replySettled = false
  var card = false
  var directSheet = false
  var sheetDismissed = false
  var actions = PodActions()
}

@MainActor private struct ReplyDraftHost: View {
  let fixture: PodStoreLifetimeFixture
  @Bindable var inputs: ReplyDraftInputs
  var body: some View {
    if let pod = fixture.store.selectedSession {
      if inputs.directSheet {
        DecisionReplySheet(podID: pod.id, actions: inputs.actions.decisionReply) { inputs.sheetDismissed = true }
          .background(Color(nsColor: .windowBackgroundColor))
      } else if inputs.card {
        SessionCardFinal(pod: pod, actions: inputs.actions).padding(20)
      } else {
        DetailPanelView(pod: pod, events: [], actions: inputs.actions, selectedTab: $inputs.tab)
      }
    }
  }
}

@MainActor private func replySubviews(_ view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(replySubviews)
}

@MainActor private final class ReplyDraftWindow {
  let inputs = ReplyDraftInputs()
  var handler: ActionHandler
  let fixture: PodStoreLifetimeFixture
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let suite = "autopod-reply-baseline-\(UUID().uuidString)"
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let oldEnhanced: Any?

  init(_ fixture: PodStoreLifetimeFixture, width: CGFloat = 900, card: Bool = false, directSheet: Bool = false) {
    self.fixture = fixture
    handler = ActionHandler(api: fixture.apiA, podStore: fixture.store, profileStore: ProfileStore())
    var actions = handler.actions
    let productionReply = actions.decisionReply.submit
    let preparation = actions.decisionReply.prepare
    let inputs = inputs
    // Retain/join real tasks, without replacing draft or submission behavior.
    actions.decisionReply.submit = { id, decision in
      let task = fixture.track(productionReply(id, decision))
      fixture.start { _ = await task.value; inputs.replySettled = true }
      return task
    }
    actions.decisionReply.prepare = { id in
      await fixture.track(Task { await preparation(id) }).value
    }
    inputs.actions = actions
    inputs.card = card
    inputs.directSheet = directSheet
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    hosting = NSHostingView(rootView: AnyView(ReplyDraftHost(fixture: fixture, inputs: inputs)
      .defaultAppStorage(UserDefaults(suiteName: suite)!)
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    hosting.appearance = NSAppearance(named: .darkAqua)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: directSheet ? 350 : 760),
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

  var targetWindow: NSWindow { window.sheets.first ?? window }
  var rootView: NSView { targetWindow.contentView ?? hosting }

  func reconnect() {
    fixture.store.configure(api: fixture.apiA)
    handler = ActionHandler(api: fixture.apiA, podStore: fixture.store, profileStore: ProfileStore())
    var actions = handler.actions
    let fixture = fixture
    let submit = actions.decisionReply.submit
    let prepare = actions.decisionReply.prepare
    actions.decisionReply.submit = { id, decision in fixture.track(submit(id, decision)) }
    actions.decisionReply.prepare = { id in await fixture.track(Task { await prepare(id) }).value }
    inputs.actions = actions
  }

  var field: NSTextField? {
    window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); hosting.displayIfNeeded()
    rootView.layoutSubtreeIfNeeded()
    return replySubviews(rootView).compactMap { $0 as? NSTextField }
      .first { $0.placeholderString == "Type your reply..." || $0.placeholderString == "Type your reply…" }
  }

  func wait(_ label: String, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !condition() {
      guard ContinuousClock.now < deadline else {
        print("REPLY_DRAFT timeout: \(label)")
        throw URLError(.timedOut)
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func type(_ text: String) async throws {
    try await wait("reply field mounted") { self.field != nil }
    let field = try #require(field)
    #expect(targetWindow.makeFirstResponder(field))
    let editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
    try await wait("native text binding") { field.stringValue == text }
    #expect(targetWindow.firstResponder === editor)
  }

  func nativeReturn() throws {
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: targetWindow.windowNumber, context: nil, characters: "\r",
      charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    NSApplication.shared.sendEvent(event)
  }

  func nodes(_ root: NSObject) -> [NSObject] {
    [root] + (ax(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
  }
  func ax(_ node: NSObject, _ key: String) -> Any? {
    guard node.responds(to: NSSelectorFromString(key)) else { return nil }
    return node.value(forKey: key)
  }
  var renderedText: String {
    rootView.layoutSubtreeIfNeeded()
    return nodes(rootView).flatMap { node in
      ["accessibilityLabel", "accessibilityValue"].compactMap { ax(node, $0) as? String }
    }.joined(separator: "\n")
  }
  func press(_ identifier: String) async throws {
    try await wait("button \(identifier)") {
      self.rootView.layoutSubtreeIfNeeded()
      return self.nodes(self.rootView).contains { self.ax($0, "accessibilityIdentifier") as? String == identifier }
    }
    let node = try #require(nodes(rootView).first { ax($0, "accessibilityIdentifier") as? String == identifier })
    try #require(node.responds(to: NSSelectorFromString("accessibilityPerformPress")))
    _ = ax(node, "accessibilityPerformPress")
  }

  func capture(_ stage: String) throws {
    let text = field?.stringValue
    let editor = (targetWindow.firstResponder as? NSTextView)?.string
    print("REPLY_DRAFT \(stage) field=\(String(reflecting: text)) editor=\(String(reflecting: editor))")
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_REPLY_DRAFT_RENDER_DIR"] else { return }
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    let captureView = replySubviews(rootView).first { String(describing: Swift.type(of: $0)).contains("HostingView") } ?? rootView
    print("REPLY_DRAFT capture view=\(Swift.type(of: captureView)) sheet=\(!window.sheets.isEmpty)")
    let bitmap = try #require(captureView.bitmapImageRepForCachingDisplay(in: captureView.bounds))
    NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
      captureView.cacheDisplay(in: captureView.bounds, to: bitmap)
    }
    try #require(bitmap.representation(using: .png, properties: [:]))
      .write(to: url.appendingPathComponent(stage + ".png"))
    try "field=\(String(reflecting: text))\neditor=\(String(reflecting: editor))\nframe=\(rootView.bounds)\n"
      .write(to: url.appendingPathComponent(stage + ".txt"), atomically: true, encoding: .utf8)
  }
}

func replyRequestData(_ request: URLRequest) throws -> Data {
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

@MainActor @Suite(.serialized)
struct DecisionReplyDraftRenderingTests {
  @Test func nativeReplySurvivesOverviewUnmountAndRemount() async throws {
    try await withPodStoreLifetimeFixture { fixture in
      fixture.store.upsertSession(try decisionPod("A"))
      fixture.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(fixture)
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

  @Test(arguments: [600.0, 900.0]) func nativeReturnRetainsReplyDuringHeldPostAndAfter500(width: Double) async throws {
    try await withPodStoreLifetimeFixture { fixture in
      fixture.store.upsertSession(try decisionPod("A"))
      fixture.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(fixture, width: width)
      defer { view.close() }
      let draft = "Keep synthetic draft R04f-post-58c2"
      try await view.type(draft)
      try view.capture("post-before-return")
      try view.nativeReturn()
      try view.nativeReturn() // Same event turn must not create a second admission.
      try await fixture.next(fixture.a, "/pods/decision").respond(body: decisionSnapshot("A"))
      let request = try await fixture.a.next()
      #expect(request.request.httpMethod == "POST")
      #expect(request.request.url?.path == "/pods/decision/message")
      let body = try #require(JSONSerialization.jsonObject(with: replyRequestData(request.request)) as? [String: String])
      #expect(body == ["message": draft])
      #expect(fixture.a.activeCount == 1)
      #expect(!view.inputs.replySettled)
      try view.capture("post-held-\(Int(width))")
      #expect(view.field?.stringValue == draft)
      request.respond(status: 500, body: #"{"error":"Synthetic reply response failure"}"#)
      try await fixture.next(fixture.a, "/pods/decision").respond(status: 500, body: "{}")
      try await view.wait("real handler and owned task settled") { view.inputs.replySettled }
      #expect(view.handler.actions.decisionReply.snapshot("decision", "A").notice?.contains("unconfirmed") == true)
      #expect(view.handler.pendingAction == nil)
      try view.capture("post-after-500-\(Int(width))")
      #expect(view.field?.stringValue == draft)
      #expect(fixture.store.selectedSession?.escalationId == "A")
      #expect(fixture.store.selectedSession?.status == .awaitingInput)
      #expect(fixture.a.requests.count == 3 && fixture.b.requests.isEmpty)
    }
  }
  @Test func nativeReconnectAcknowledgementAndNewQuestion() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A")); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 600)
      defer { view.close() }
      try await view.type("Reconnect draft")
      f.store.disconnect()
      try await view.wait("reconnecting notice") { view.renderedText.contains("Reconnecting") }
      try view.capture("overview-reconnecting-600")
      #expect(view.field?.stringValue == "Reconnect draft")
      view.reconnect()
      try await view.wait("reconnected draft rendered") { !view.renderedText.contains("Reconnecting") && view.field?.stringValue == "Reconnect draft" }
      try await view.type("Reconnect draft")
      try view.nativeReturn()
      try await f.next(f.a, "/pods/decision").respond(body: decisionSnapshot("A"))
      let post = try await f.a.next()
      #expect(post.request.httpMethod == "POST")
      post.respond(body: "{\"ok\":true}")
      let refresh = try await f.next(f.a, "/pods/decision")
      try await view.wait("ack before held GET") { view.renderedText.contains("acknowledged") && view.field?.stringValue == "" }
      try view.capture("overview-acknowledged-600")
      #expect(f.store.selectedSession?.status == .awaitingInput)
      refresh.respond(body: try decisionSnapshot("B"))
      try await view.wait("new question") { view.renderedText.contains("Question B?") }
      try view.capture("overview-new-question-600")
      #expect(view.field?.stringValue == "")
      #expect(f.a.requests.count == 3)
    }
  }

  @Test func actualCardSheetSharesTextRetainsFailureAndCancelsOnlyText() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A")); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 600)
      defer { view.close() }
      try await view.type("Shared detail and card draft")
      view.inputs.card = true
      try await view.press("decision-card-reply")
      try await view.wait("actual sheet and field") { !view.window.sheets.isEmpty && view.field != nil }
      #expect(view.field?.stringValue == "Shared detail and card draft")
      try view.capture("card-shared-draft")
      try await view.type("Card answer")
      view.inputs.card = false
      try await view.wait("ordinary unmount closes sheet") { view.window.sheets.isEmpty && view.field != nil }
      #expect(view.field?.stringValue == "Card answer")
      view.inputs.card = true
      try await view.press("decision-card-reply")
      try await view.type("Card answer")
      try view.nativeReturn()
      try await f.next(f.a, "/pods/decision").respond(body: decisionSnapshot("A"))
      let post = try await f.a.next()
      #expect(try JSONSerialization.jsonObject(with: replyRequestData(post.request)) as? [String: String] == ["message": "Card answer"])
      try view.capture("card-sending")
      post.respond(status: 500, body: "{}")
      let refresh = try await f.next(f.a, "/pods/decision")
      try await view.wait("card unconfirmed before GET") { view.renderedText.contains("unconfirmed") }
      try view.capture("card-unconfirmed")
      #expect(!view.window.sheets.isEmpty)
      #expect(view.field?.stringValue == "Card answer")
      refresh.respond(status: 500, body: "{}")
      try await view.wait("attempt settled") { !view.handler.actions.decisionReply.snapshot("decision", "A").pending }
      try await view.press("decision-sheet-cancel")
      try await view.wait("sheet dismissed") { view.window.sheets.isEmpty }
      view.inputs.card = false
      try await view.wait("Overview remounted") { view.field != nil }
      #expect(view.field?.stringValue == "")
      #expect(f.a.requests.count == 3)
    }
  }

  @Test(arguments: ["approve", "reject"]) func unknownCardHydratesApprovalWithoutDismissingAndButtonSendsExactAnswer(choice: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      var unknown = try decisionPod(nil)
      unknown.escalationQuestion = "Compact question"
      f.store.upsertSession(unknown); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 600, card: true)
      defer { view.close() }
      #expect(f.a.requests.isEmpty)
      try await view.press("decision-card-reply")
      let get = try await f.next(f.a, "/pods/decision")
      try await view.wait("unknown actual sheet") { !view.window.sheets.isEmpty && view.renderedText.contains("Loading current question") }
      try view.capture("card-question-loading")
      var response = try #require(JSONSerialization.jsonObject(with: Data(decisionSnapshot("A").utf8)) as? [String: Any])
      var escalation = try #require(response["pendingEscalation"] as? [String: Any])
      escalation["type"] = "action_approval"
      response["pendingEscalation"] = escalation
      get.respond(body: try decisionJSON(response))
      try await view.wait("hydrated approval") { view.renderedText.contains("Approve") && view.renderedText.contains("Question A?") }
      #expect(!view.window.sheets.isEmpty)
      try view.capture("card-hydrated-approval")
      try await view.press("decision-sheet-\(choice)")
      try await f.next(f.a, "/pods/decision").respond(body: decisionJSON(response))
      let post = try await f.a.next()
      #expect(try JSONSerialization.jsonObject(with: replyRequestData(post.request)) as? [String: String] == ["message": choice == "approve" ? "approved" : "rejected"])
      post.respond(body: "{\"ok\":true}")
      let refresh = try await f.next(f.a, "/pods/decision")
      try await view.wait("sheet acknowledgement") { view.renderedText.contains("acknowledged") }
      try view.capture("card-approval-acknowledged")
      refresh.respond(status: 500, body: "{}")
      try await view.wait("acknowledged sheet dismissal") { view.window.sheets.isEmpty }
      #expect(f.a.requests.count == 4)
    }
  }

  @Test(arguments: ["overview-option", "overview-approve", "overview-reject", "card-approve", "card-reject", "sheet-option"])
  func nativeChoiceButtonsRetainExactSelectedAnswer(choice: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let approval = !choice.hasSuffix("option")
      var pod = try decisionPod("A")
      if approval { pod.escalationType = "action_approval" }
      f.store.upsertSession(pod); f.store.selectedSessionId = "decision"
      let card = choice.hasPrefix("card") || choice.hasPrefix("sheet")
      let view = ReplyDraftWindow(f, width: 600, card: card)
      defer { view.close() }
      if choice.hasPrefix("sheet") {
        try await view.press("decision-card-reply")
        try await view.wait("sheet mounted") { !view.window.sheets.isEmpty && view.field != nil }
      }
      if !approval { try await view.type("typed before option") }
      else { view.handler.actions.decisionReply.edit("decision", "A", "typed before approval") }
      let answer = choice.hasSuffix("option") ? "A first" : choice.hasSuffix("approve") ? "approved" : "rejected"
      let identifier = choice.hasSuffix("option")
        ? "decision-\(choice.hasPrefix("sheet") ? "sheet" : "overview")-option-A first"
        : "decision-\(choice)"
      try await view.press(identifier)
      var response = try #require(JSONSerialization.jsonObject(with: Data(decisionSnapshot("A").utf8)) as? [String: Any])
      if approval {
        var escalation = try #require(response["pendingEscalation"] as? [String: Any])
        escalation["type"] = "action_approval"; response["pendingEscalation"] = escalation
      }
      try await f.next(f.a, "/pods/decision").respond(body: decisionJSON(response))
      let post = try await f.a.next()
      #expect(post.request.httpMethod == "POST")
      #expect(try JSONSerialization.jsonObject(with: replyRequestData(post.request)) as? [String: String] == ["message": answer])
      #expect(view.handler.actions.decisionReply.snapshot("decision", "A").text == answer)
      post.respond(status: 500, body: "{}")
      try await f.next(f.a, "/pods/decision").respond(status: 500, body: "{}")
      try await view.wait("selected answer unconfirmed") { view.renderedText.contains("unconfirmed") }
      try view.capture("choice-\(choice)-unconfirmed")
      #expect(view.handler.actions.decisionReply.snapshot("decision", "A").text == answer)
      #expect(f.a.requests.count == 3)
    }
  }

  @Test func oldAcknowledgementDoesNotDismissNewSheetQuestion() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A")); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 600, card: true)
      defer { view.close() }
      try await view.press("decision-card-reply")
      try await view.type("Answer A")
      try view.nativeReturn()
      try await f.next(f.a, "/pods/decision").respond(body: decisionSnapshot("A"))
      let post = try await f.a.next()
      post.respond(body: "{\"ok\":true}")
      let refresh = try await f.next(f.a, "/pods/decision")
      f.store.setEscalation("decision", question: "Question B?", options: ["B first", "B second"], id: "B", type: "ask_human")
      try await view.wait("B rendered in same sheet") { view.renderedText.contains("Question B?") }
      try await view.type("New B draft")
      refresh.respond(body: try decisionSnapshot("A"))
      try await view.wait("old reply settled") { view.inputs.replySettled }
      #expect(!view.window.sheets.isEmpty)
      #expect(view.field?.stringValue == "New B draft")
      #expect(f.store.selectedSession?.escalationId == "B")
      try view.capture("card-new-question-retained")
    }
  }

  @Test func unknownOverviewReportsLoadingFailureAndRetry() async throws {
    try await withPodStoreLifetimeFixture { f in
      var unknown = try decisionPod(nil); unknown.escalationQuestion = "Compact question"
      f.store.upsertSession(unknown); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 600)
      defer { view.close() }
      let get = try await f.next(f.a, "/pods/decision")
      try await view.wait("question loading") { view.renderedText.contains("Loading current question") }
      try view.capture("overview-question-loading")
      get.respond(status: 500, body: "{}")
      try await view.wait("question unavailable") { view.renderedText.contains("Could not load this question") }
      #expect(view.field?.isEnabled == false)
      try view.capture("overview-question-unavailable")
      #expect(f.a.requests.count == 1)
      try await view.press("decision-refresh-question")
      try await f.next(f.a, "/pods/decision").respond(body: decisionSnapshot("A"))
      try await view.wait("retry loads exact question") { view.renderedText.contains("Question A?") && view.field?.isEnabled == true }
      try await view.type("Retain on preflight failure")
      try view.nativeReturn()
      try await f.next(f.a, "/pods/decision").respond(status: 500, body: "{}")
      try await view.wait("not admitted notice") { view.renderedText.contains("Reply not sent") }
      try view.capture("overview-reply-not-admitted")
      #expect(view.field?.stringValue == "Retain on preflight failure")
      #expect(f.a.requests.count == 3 && f.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  // Supplementary raster proof: actual AppKit sheet interaction is exercised above.
  // cacheDisplay loses sheet vibrancy/buttons, so mount the identical production
  // content in an ordinary NSHostingView for legible appearance at sheet width.
  @Test(arguments: ["question", "approval", "unknown"])
  func productionSheetAppearanceWithoutVibrancyMask(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      var pod = try decisionPod(kind == "unknown" ? nil : "A")
      if kind == "approval" { pod.escalationType = "action_approval" }
      if kind == "unknown" { pod.escalationQuestion = "Compact question" }
      f.store.upsertSession(pod); f.store.selectedSessionId = "decision"
      let view = ReplyDraftWindow(f, width: 560, directSheet: true)
      defer { view.close() }
      if kind == "unknown" {
        let get = try await f.next(f.a, "/pods/decision")
        try await view.wait("loading component") { view.renderedText.contains("Loading current question") }
        try view.capture("production-sheet-loading")
        get.respond(status: 500, body: "{}")
        try await view.wait("unavailable component") { view.renderedText.contains("Could not load") }
        try view.capture("production-sheet-unavailable")
        return
      }
      if kind == "question" { try await view.type("Production sheet draft") }
      else { try await view.wait("approval component") { view.renderedText.contains("Approve") } }
      try view.capture("production-sheet-\(kind)-ready")
      let control = kind == "question" ? "decision-sheet-option-A first" : "decision-sheet-approve"
      try await view.press(control)
      var response = try #require(JSONSerialization.jsonObject(with: Data(decisionSnapshot("A").utf8)) as? [String: Any])
      if kind == "approval" {
        var escalation = try #require(response["pendingEscalation"] as? [String: Any])
        escalation["type"] = "action_approval"; response["pendingEscalation"] = escalation
      }
      try await f.next(f.a, "/pods/decision").respond(body: decisionJSON(response))
      let post = try await f.a.next()
      try await view.wait("sending component") { view.renderedText.contains("Sending reply") }
      try view.capture("production-sheet-\(kind)-sending")
      post.respond(status: 500, body: "{}")
      let refresh = try await f.next(f.a, "/pods/decision")
      try await view.wait("unconfirmed component") { view.renderedText.contains("unconfirmed") }
      try view.capture("production-sheet-\(kind)-unconfirmed")
      refresh.respond(status: 500, body: "{}")
      try await view.wait("retry enabled") { view.handler.actions.decisionReply.snapshot("decision", "A").canSubmit }
      try await view.press(control)
      try await f.next(f.a, "/pods/decision").respond(body: decisionJSON(response))
      try await f.a.next().respond(body: "{\"ok\":true}")
      let finalRefresh = try await f.next(f.a, "/pods/decision")
      try await view.wait("ack component") { view.renderedText.contains("acknowledged") }
      try view.capture("production-sheet-\(kind)-acknowledged")
      finalRefresh.respond(status: 500, body: "{}")
      try await view.wait("ack dismissal callback") { view.inputs.sheetDismissed }
    }
  }

}
