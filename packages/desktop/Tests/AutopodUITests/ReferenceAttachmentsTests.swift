import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct ReferenceAttachmentsTests {
  @Test func manifestFailureRetriesAndFileReadsAreCached() async throws {
    let fixture = try ReferenceFixture()
    var attempts = 0
    var reads = 0
    var actions = fixture.actions
    actions.readLaunch = { _ in
      attempts += 1
      if attempts == 1 { throw DaemonError.notFound("Unavailable") }
      return fixture.launch
    }
    actions.readInputFile = { _, index in reads += 1; return fixture.files[index].bytes }
    let model = ReferenceAttachmentsModel(actions: actions)
    await model.load(podId: "fixture")
    #expect(model.error != nil && model.bundle == nil && !model.isLoading)
    await model.load(podId: "fixture")
    #expect(model.error == nil && model.bundle?.files.count == 3)
    await model.loadFile(0)
    await model.loadFile(0)
    #expect(reads == 1 && model.bytes[0] == fixture.files[0].bytes)
    await model.load(podId: "another-pod")
    #expect(model.bytes.isEmpty && model.fileErrors.isEmpty)
  }

  @Test func fileFailureRetriesAndActiveFormatsOnlyOfferText() async throws {
    let fixture = try ReferenceFixture()
    var reads = 0
    var actions = fixture.actions
    actions.readInputFile = { _, index in
      reads += 1
      if reads == 1 { throw DaemonError.serverError(403, "Private reference") }
      return fixture.files[index].bytes
    }
    let model = ReferenceAttachmentsModel(actions: actions)
    await model.load(podId: "fixture")
    await model.loadFile(1)
    #expect(model.bytes[1] == nil && model.fileErrors[1]?.contains("Private reference") == true)
    await model.loadFile(1)
    #expect(model.fileErrors[1] == nil && model.bytes[1] == fixture.files[1].bytes)
    #expect(fixture.files[0].file.hasRasterPreview)
    #expect(!fixture.files[1].file.hasRasterPreview && fixture.files[1].file.hasTextPreview)
    let svg = try InputAttachment(path: "active.svg", bytes: Data("<svg/>".utf8)).file
    #expect(!svg.hasRasterPreview && svg.hasTextPreview)
    #expect(!fixture.files[2].file.hasTextPreview && !fixture.files[2].file.hasRasterPreview)
  }

  @Test func oldManifestAndFileCompletionsCannotPopulateNewPod() async throws {
    let fixture = try ReferenceFixture()
    var held: CheckedContinuation<EffectiveLaunchPreview, Never>?
    var actions = fixture.actions
    actions.readLaunch = { id in
      if id == "old" { return await withCheckedContinuation { held = $0 } }
      return fixture.launch
    }
    let model = ReferenceAttachmentsModel(actions: actions)
    let old = Task { await model.load(podId: "old") }
    while held == nil { await Task.yield() }
    await model.load(podId: "new")
    held?.resume(returning: try referenceLaunch(.object([:])))
    await old.value
    #expect(model.bundle?.files.count == 3)

    var pending: CheckedContinuation<Data, Never>?
    actions.readInputFile = { _, _ in await withCheckedContinuation { pending = $0 } }
    let fileModel = ReferenceAttachmentsModel(actions: actions)
    await fileModel.load(podId: "new")
    let file = Task { await fileModel.loadFile(0) }
    while pending == nil { await Task.yield() }
    await fileModel.load(podId: "next")
    pending?.resume(returning: fixture.files[0].bytes)
    await file.value
    #expect(fileModel.bytes.isEmpty && fileModel.loadingFiles.isEmpty)
  }

  @Test func cancelledReadsPublishNeitherPrivateBytesNorErrors() async throws {
    let fixture = try ReferenceFixture()
    var pending: CheckedContinuation<Data, Never>?
    var actions = fixture.actions
    actions.readInputFile = { _, _ in await withCheckedContinuation { pending = $0 } }
    let model = ReferenceAttachmentsModel(actions: actions)
    await model.load(podId: "fixture")
    let task = Task { await model.loadFile(0) }
    while pending == nil { await Task.yield() }
    task.cancel()
    pending?.resume(returning: fixture.files[0].bytes)
    await task.value
    #expect(model.bytes.isEmpty && model.fileErrors.isEmpty && model.loadingFiles.isEmpty)
  }

  @Test func cancelledManifestDoesNotConfirmEmpty() async throws {
    let fixture = try ReferenceFixture()
    var pending: CheckedContinuation<EffectiveLaunchPreview, Never>?
    var actions = fixture.actions
    actions.readLaunch = { _ in await withCheckedContinuation { pending = $0 } }
    let model = ReferenceAttachmentsModel(actions: actions)
    let task = Task { await model.load(podId: "fixture") }
    while pending == nil { await Task.yield() }
    task.cancel()
    pending?.resume(returning: try referenceLaunch(.object([:])))
    await task.value
    #expect(!model.hasLoaded && model.bundle == nil && model.error == nil)
  }

  @Test func closingAndImmediatelyReopeningPreviewSharesThePendingRead() async throws {
    let fixture = try ReferenceFixture()
    var pending: CheckedContinuation<Data, Never>?
    var reads = 0
    var actions = fixture.actions
    actions.readInputFile = { _, _ in
      reads += 1
      return await withCheckedContinuation { pending = $0 }
    }
    let model = ReferenceAttachmentsModel(actions: actions)
    await model.load(podId: "fixture")
    let closing = Task { await model.loadFile(1) }
    while pending == nil { await Task.yield() }
    closing.cancel()
    let reopened = Task { await model.loadFile(1) }
    await Task.yield()
    pending?.resume(returning: fixture.files[1].bytes)
    await closing.value
    await reopened.value
    #expect(reads == 1)
    #expect(model.bytes[1] == fixture.files[1].bytes && model.fileErrors[1] == nil)
    #expect(model.loadingFiles.isEmpty)
  }

  @Test(arguments: [false, true]) func taskCardLoadsAndOpensNativeImagePreview(light: Bool) async throws {
    let fixture = try ReferenceFixture()
    var pod = MockData.running
    pod.task = "Inspect the attached screenshot and design references."
    let host = ReferenceHost(WorkTab(pod: pod, configurationActions: fixture.actions)
      .environment(\.desktopRedesign, true).preferredColorScheme(light ? .light : .dark), light: light)
    defer { host.close() }
    try await host.wait { host.has("reference-attachment-0") && fixture.reads.contains(0) }
    #expect(host.text.contains(pod.task))
    #expect(!host.text.contains("Dispatch preflight"))
    #expect(!host.text.contains("Execution details"))
    #expect(!host.text.contains("Intentional rerun"))
    #expect(host.has("reference-attachments-card"))
    #expect(!host.has("reference-attachments-empty"))
    #expect(host.text.contains("Provided inputs · not added to source"))
    #expect(host.text.contains("reference-screen.png"))
    #expect(host.text.contains("design.html"))
    #expect(host.text.contains("guide.pdf"))
    #expect(fixture.reads == [0], "Only raster thumbnails auto-download, not active files")
    try host.capture("task-card-\(light ? "light" : "dark")")
    try host.press("reference-attachment-0")
    try await host.wait { host.sheetHas("reference-attachment-image") }
    #expect(host.sheetHas("reference-attachment-save"))
    #expect(fixture.reads == [0], "Opening an already-loaded thumbnail reuses verified original bytes")
    try host.captureSheet("image-preview-\(light ? "light" : "dark")")
    try host.pressSheet("reference-attachment-zoom")
    try await host.wait { host.sheetText.contains("Fit image") }
    try host.pressSheet("reference-attachment-close")
    try await host.wait { host.window.attachedSheet == nil }
  }

  @Test(arguments: [1, 2]) func otherFilesOfferInertPreviewOrSave(index: Int) async throws {
    let fixture = try ReferenceFixture()
    let host = ReferenceHost(VStack { ReferenceAttachmentsCard(podId: "fixture", actions: fixture.actions) })
    defer { host.close() }
    try await host.wait { host.has("reference-attachment-\(index)") }
    try host.press("reference-attachment-\(index)")
    try await host.wait {
      host.sheetHas("reference-attachment-save") && fixture.reads.contains(index)
        && host.sheetText.contains(index == 1 ? "Source preview" : "Preview unavailable")
    }
    #expect(!host.sheetHas("reference-attachment-image"))
    if index == 1 {
      #expect(host.sheetText.contains("Source preview · active content is not executed"))
      #expect(host.sheetText.contains("<script>fetch("))
    } else {
      #expect(host.sheetText.contains("Preview unavailable"))
    }
    try host.captureSheet(index == 1 ? "source-preview" : "file-details")
  }

  @Test func emptyInputsShowZeroAndLoadFailureIsNotMisrepresentedAsEmpty() async throws {
    let fixture = try ReferenceFixture()
    var loads = 0
    var actions = fixture.actions
    actions.readLaunch = { _ in loads += 1; return try referenceLaunch(.object([:])) }
    let empty = ReferenceHost(VStack { Text("Task"); ReferenceAttachmentsCard(podId: "old", actions: actions) })
    defer { empty.close() }
    try await empty.wait { loads == 1 && empty.has("reference-attachments-empty") }
    #expect(empty.has("reference-attachments-card"))
    #expect(empty.text.contains("0 attachments"))
    #expect(!empty.has("reference-attachments-retry"))
    actions.readLaunch = { _ in throw DaemonError.serverError(403, "Private references") }
    let denied = ReferenceHost(VStack { Text("Task"); ReferenceAttachmentsCard(podId: "private", actions: actions) })
    defer { denied.close() }
    try await denied.wait { denied.has("reference-attachments-retry") }
    #expect(denied.text.contains("Couldn't load references"))
    #expect(!denied.has("reference-attachments-empty"))
    #expect(!denied.text.contains("0 attachments"))
  }

  @Test(arguments: ["small.txt", "retained-final.patch.txt", "long.txt", "long.md", "unbroken.txt", "limit.txt", "active.svg", "active.html"])
  func sourcePreviewRendersWrapsAndScrolls(path: String) async throws {
    let paragraph = "  unchanged whitespace\t" + String(repeating: "long source paragraph ", count: 80)
    let source: String
    switch path {
    case "small.txt": source = "Small plain text\n  indented\tvalue\n"
    case "retained-final.patch.txt":
      source = String(repeating: "@@ -1,2 +1,2 @@\n-old source line\n+new source line with retained whitespace\n", count: 1500)
    case "unbroken.txt": source = String(repeating: "x", count: 8000)
    case "limit.txt": source = String(repeating: "bounded source\n", count: 22000)
    case "active.svg": source = "<svg onload=\"alert('inert')\"><script>neverExecute()</script></svg>"
    case "active.html": source = "<script>neverExecute()</script><p>Literal source</p>"
    default: source = paragraph + "\n\n" + paragraph
    }
    let bytes = Data((source + "\nEND OF SOURCE").utf8)
    let attachment = try InputAttachment(path: path, bytes: bytes)
    #expect(attachment.file.hasTextPreview && !attachment.file.hasRasterPreview)
    if path == "retained-final.patch.txt" { #expect(bytes.count > 100 * 1024 && bytes.count < 110 * 1024) }
    let fixture = try ReferenceFixture(attachments: [attachment])
    let host = ReferenceHost(ReferenceAttachmentsCard(podId: "fixture", actions: fixture.actions))
    defer { host.close() }
    try await host.wait { host.has("reference-attachment-0") }
    try host.press("reference-attachment-0")
    let expected = String(decoding: bytes.prefix(256 * 1024), as: UTF8.self)
    // SwiftUI can publish AX nodes before attaching the represented AppKit view.
    try await host.wait {
      guard let text = host.sourceTextView else { return false }
      return text.string == expected && text.visibleRect.width > 0 && text.visibleRect.height > 0
    }
    let sheet = try #require(host.window.attachedSheet?.contentView)
    let text = try #require(host.sourceTextView)
    let scroll = try #require(text.enclosingScrollView)
    let layout = try #require(text.layoutManager)
    let container = try #require(text.textContainer)
    sheet.layoutSubtreeIfNeeded()
    layout.ensureLayout(for: container)
    #expect(text.string == expected)
    #expect(text.isSelectable && !text.isEditable && !text.isRichText)
    #expect(!scroll.hasHorizontalScroller && scroll.hasVerticalScroller)
    #expect(text.bounds.width <= scroll.contentSize.width + 1)
    #expect(layout.usedRect(for: container).width <= container.containerSize.width + 1)
    let firstGlyph = layout.boundingRect(forGlyphRange: NSRange(location: 0, length: 1), in: container)
      .offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y)
    #expect(firstGlyph.width > 0 && firstGlyph.height > 0 && firstGlyph.intersects(text.visibleRect))
    try expectVisibleInk(text)
    try host.captureSheet("source-\(path)-top")

    if ["long.txt", "long.md", "unbroken.txt"].contains(path) {
      let firstNewline = (expected as NSString).range(of: "\n").location
      let line = layout.glyphRange(forCharacterRange: NSRange(location: 0, length: firstNewline), actualCharacterRange: nil)
      var fragments = 0
      layout.enumerateLineFragments(forGlyphRange: line) { rect, used, _, _, _ in
        fragments += 1
        #expect(used.maxX <= container.containerSize.width + 1)
        #expect(rect.height > 0)
      }
      #expect(fragments > 1, "One physical source line must occupy multiple visual lines")
    }
    let last = NSRange(location: (expected as NSString).length - 1, length: 1)
    let lastGlyph = layout.glyphRange(forCharacterRange: last, actualCharacterRange: nil)
    let endRect = layout.boundingRect(forGlyphRange: lastGlyph, in: container)
      .offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y)
    if path == "retained-final.patch.txt" || path == "limit.txt" || path == "unbroken.txt" {
      #expect(!endRect.intersects(text.visibleRect))
      text.scrollRangeToVisible(last)
      #expect(scroll.contentView.bounds.minY > 0)
      #expect(endRect.intersects(text.visibleRect))
      try expectVisibleInk(text)
      try host.captureSheet("source-\(path)-bottom")
    }
    let selection = NSRange(location: 0, length: (expected as NSString).length)
    text.setSelectedRange(selection)
    #expect(text.selectedRange() == selection)
    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    // Export the formats AppKit advertises for this selection, as Copy does.
    // NSTextView may advertise legacy string identifiers rather than `.string`.
    let types = text.writablePasteboardTypes
    try #require(!types.isEmpty)
    #expect(text.writeSelection(to: pasteboard, types: types), "Advertised types: \(types)")
    #expect(pasteboard.string(forType: .string) == expected)
    #expect(host.sheetText.contains("Preview limited to 256 KiB") == (bytes.count > 256 * 1024))
    // Display truncation must never mutate the bytes backing Save.
    let model = ReferenceAttachmentsModel(actions: fixture.actions)
    await model.load(podId: "fixture")
    await model.loadFile(0)
    #expect(model.bytes[0] == bytes)
    #expect(host.sheetHas("reference-attachment-save") && host.sheetHas("reference-attachment-close"))
  }
}

@MainActor private func referenceViews(_ view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(referenceViews)
}

/// Check painted pixels as well as glyph geometry: AX strings alone can pass for a blank view.
@MainActor private func expectVisibleInk(_ text: NSTextView) throws {
  let rect = text.visibleRect
  let bitmap = try #require(text.bitmapImageRepForCachingDisplay(in: rect))
  text.cacheDisplay(in: rect, to: bitmap)
  var minimum: CGFloat = 1
  var maximum: CGFloat = 0
  for y in 0..<min(bitmap.pixelsHigh, 100) {
    for x in 0..<bitmap.pixelsWide {
      if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
        let value = color.alphaComponent * (color.redComponent + color.greenComponent + color.blueComponent) / 3
        minimum = min(minimum, value)
        maximum = max(maximum, value)
      }
    }
  }
  #expect(maximum - minimum > 0.1, "Visible source viewport must contain painted text")
}

@MainActor private final class ReferenceFixture {
  let files: [InputAttachment]
  let launch: EffectiveLaunchPreview
  var reads: [Int] = []
  init(attachments: [InputAttachment]? = nil) throws {
    let png: Data
    if let path = ProcessInfo.processInfo.environment["AUTOPOD_REFERENCE_IMAGE"] {
      png = try Data(contentsOf: URL(fileURLWithPath: path))
    } else {
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 80, pixelsHigh: 60,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
      for x in 0..<80 { for y in 0..<60 { bitmap.setColor(NSColor(deviceRed: 0.5, green: 0.2, blue: 0.8, alpha: 1), atX: x, y: y) } }
      png = bitmap.representation(using: .png, properties: [:])!
    }
    files = try attachments ?? [InputAttachment(path: "reference-screen.png", bytes: png),
      InputAttachment(path: "design.html", bytes: Data("<script>fetch('https://do-not-execute.invalid')</script>".utf8)),
      InputAttachment(path: "guide.pdf", bytes: Data("%PDF-1.7".utf8))]
    let value: ConfigurationJSON = .object(["work": .object(["inputBundle": .object([
      "id": .string("inputs-12345678-1234-1234-1234-123456789abc"),
      "digest": .string(String(repeating: "a", count: 64)),
      "files": .array(try files.map { try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode($0.file)) }),
    ])])])
    launch = try referenceLaunch(value)
  }
  var actions: LaunchConfigurationActions {
    var actions = LaunchConfigurationActions(documents: [], capabilities: .object([:]), reload: {},
      resolve: { _ in self.launch }, launch: { _ in throw URLError(.unsupportedURL) },
      save: { _, _ in throw URLError(.unsupportedURL) }, archive: { _ in },
      discoverGitHubRepositories: { [] }, discoverGitHubWorkflows: { _ in [] }, loadProviderAccounts: { [] },
      discoverPim: { _ in .object([:]) }, saveFromLaunch: { _ in .object([:]) }, readLaunch: { _ in self.launch })
    actions.connectionID = "reference-fixture"
    actions.readInputFile = { _, index in self.reads.append(index); return self.files[index].bytes }
    return actions
  }
}
private func referenceLaunch(_ value: ConfigurationJSON) throws -> EffectiveLaunchPreview {
  try JSONDecoder().decode(EffectiveLaunchPreview.self, from: JSONEncoder().encode(value))
}

@MainActor private final class ReferenceHost {
  let window: NSWindow
  let view: NSView
  private let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  private let priorEnhanced: Any?
  init<V: View>(_ root: V, light: Bool = false) {
    NSApplication.shared.finishLaunching()
    priorEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    view = NSHostingView(rootView: root)
    window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 980, height: 780), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
    view.appearance = window.appearance
    window.contentView = view
    window.orderBack(nil)
  }
  func close() {
    window.attachedSheet?.close(); window.close()
    NSApplication.shared.accessibilitySetValue(priorEnhanced, forAttribute: enhanced)
  }
  var nodes: [NSObject] { referenceNodes(view) }
  var text: String { nodes.flatMap { [referenceValue($0, "accessibilityLabel") as? String, referenceValue($0, "accessibilityValue") as? String].compactMap { $0 } }.joined(separator: "\n") }
  func has(_ id: String) -> Bool { nodes.contains { referenceValue($0, "accessibilityIdentifier") as? String == id } }
  func sheetHas(_ id: String) -> Bool {
    guard let content = window.attachedSheet?.contentView else { return false }
    return referenceNodes(content).contains { referenceValue($0, "accessibilityIdentifier") as? String == id }
  }
  var sourceTextView: NSTextView? {
    guard let content = window.attachedSheet?.contentView else { return nil }
    return referenceViews(content).compactMap { $0 as? NSTextView }.first {
      $0.accessibilityIdentifier() == "reference-attachment-source"
    }
  }
  var sheetText: String {
    guard let content = window.attachedSheet?.contentView else { return "" }
    return referenceNodes(content).flatMap { [referenceValue($0, "accessibilityLabel") as? String, referenceValue($0, "accessibilityValue") as? String].compactMap { $0 } }.joined(separator: "\n")
  }
  func press(_ id: String) throws { try press(id, in: nodes) }
  func pressSheet(_ id: String) throws { try press(id, in: referenceNodes(try #require(window.attachedSheet?.contentView))) }
  private func press(_ id: String, in nodes: [NSObject]) throws {
    let button = try #require(nodes.first { referenceValue($0, "accessibilityIdentifier") as? String == id })
    #expect(referenceValue(button, "accessibilityPerformPress") as? Bool == true)
  }
  func wait(_ predicate: () -> Bool) async throws {
    for _ in 0..<150 {
      view.layoutSubtreeIfNeeded()
      window.attachedSheet?.contentView?.layoutSubtreeIfNeeded()
      if predicate() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    try capture("timeout")
    throw ReferenceTestError.timeout
  }
  func capture(_ name: String) throws { try capture(view, name: name) }
  func captureSheet(_ name: String) throws { try capture(try #require(window.attachedSheet?.contentView), name: name) }
  private func capture(_ view: NSView, name: String) throws {
    guard let folder = ProcessInfo.processInfo.environment["AUTOPOD_REFERENCE_SCREENSHOTS"] else { return }
    view.layoutSubtreeIfNeeded()
    let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
  }
}
private enum ReferenceTestError: Error { case timeout }
@MainActor private func referenceValue(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }; return node.value(forKey: key)
}
@MainActor private func referenceNodes(_ node: NSObject) -> [NSObject] {
  [node] + (referenceValue(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(referenceNodes)
}
