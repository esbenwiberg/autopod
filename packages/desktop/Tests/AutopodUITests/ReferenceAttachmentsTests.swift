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
    #expect(host.has("reference-attachments-card"))
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

  @Test func emptyInputsHideCardAndLoadFailureIsNotMisrepresentedAsEmpty() async throws {
    let fixture = try ReferenceFixture()
    var loads = 0
    var actions = fixture.actions
    actions.readLaunch = { _ in loads += 1; return try referenceLaunch(.object([:])) }
    let empty = ReferenceHost(VStack { Text("Task"); ReferenceAttachmentsCard(podId: "old", actions: actions) })
    defer { empty.close() }
    try await empty.wait { loads == 1 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(!empty.has("reference-attachments-card"))
    actions.readLaunch = { _ in throw DaemonError.serverError(403, "Private references") }
    let denied = ReferenceHost(VStack { Text("Task"); ReferenceAttachmentsCard(podId: "private", actions: actions) })
    defer { denied.close() }
    try await denied.wait { denied.has("reference-attachments-retry") }
    #expect(denied.text.contains("Couldn't load references"))
  }
}

@MainActor private final class ReferenceFixture {
  let files: [InputAttachment]
  let launch: EffectiveLaunchPreview
  var reads: [Int] = []
  init() throws {
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
    files = try [InputAttachment(path: "reference-screen.png", bytes: png),
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
    for _ in 0..<150 { view.layoutSubtreeIfNeeded(); if predicate() { return }; try await Task.sleep(for: .milliseconds(20)) }
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
