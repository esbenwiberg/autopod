import AppKit
import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct FileRecoveryTests {
  @Test func savedFilesComeFirstAndCopiesAreByteExactInNewFolders() async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    let model = FileRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions)
    #expect(model.selectedSourceID == "saved-workspace" && f.reads.isEmpty && model.selectedPaths.isEmpty)
    for file in try #require(model.source).files { model.toggle(file) }
    await model.copy(f.actions, chooseDirectory: { f.folder })
    #expect(model.savedCount == 2 && model.error == nil)
    let destination = try #require(model.directory)
    for (path, bytes) in f.data { #expect(try Data(contentsOf: destination.appendingPathComponent(path)) == bytes) }
    #expect(f.reads.allSatisfy { $0.sourceId == "saved-workspace" && $0.generation == 3 })
    await model.copy(f.actions, chooseDirectory: { f.folder })
    #expect(model.directory != destination && model.savedCount == 2)
    for (path, bytes) in f.data { #expect(try Data(contentsOf: destination.appendingPathComponent(path)) == bytes) }
  }

  @Test func cancellingDestinationDoesNotReadCreateFilesOrErasePreviousReceipt() async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    let model = FileRecoveryModel(podId: "pod", actions: f.actions); await model.refresh(f.actions)
    model.toggle(try #require(model.source?.files.first))
    await model.copy(f.actions, chooseDirectory: { nil })
    #expect(f.reads.isEmpty && model.directory == nil && model.results.isEmpty)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.folder.path).isEmpty)
    await model.copy(f.actions, chooseDirectory: { f.folder })
    let receipt = model.directory
    await model.copy(f.actions, chooseDirectory: { nil })
    #expect(model.directory == receipt && model.savedCount == 1 && f.reads.count == 1)
  }

  @Test(arguments: ["changed-connection", "cancel", "corrupt", "partial"])
  func interruptedCopiesNeverClaimUnwrittenBytesWereSaved(mode: String) async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    let model = FileRecoveryModel(podId: "pod", actions: f.actions); await model.refresh(f.actions)
    for file in try #require(model.source).files { model.toggle(file) }
    f.onRead = {
      if mode == "changed-connection" { f.current = false }
      if mode == "cancel" { model.cancel() }
    }
    if mode == "corrupt" { f.corrupt = true }
    if mode == "partial" { f.failPath = "nested/raw.bin" }
    await model.copy(f.actions, chooseDirectory: { f.folder })
    #expect(model.savedCount == (mode == "partial" ? 1 : 0))
    #expect(model.error != nil && !model.busy)
    let destination = try #require(model.directory)
    #expect(!FileManager.default.fileExists(atPath: destination.appendingPathComponent("nested/raw.bin").path))
    if mode == "changed-connection" || mode == "cancel" { #expect(f.reads.count == 1) }
    if mode == "changed-connection" { #expect(!model.canCopy && model.invalidated) }
  }

  @Test func unavailableOriginalNeverSwitchesSelectionBackToAnOlderSavedCopy() async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }; f.includeOriginal = true; f.originalRunning = true
    let model = FileRecoveryModel(podId: "pod", actions: f.actions)
    await model.refresh(f.actions, includeOriginal: true)
    #expect(model.selectedSourceID == "original" && model.source?.status == .available)
    f.originalRunning = false
    await model.refresh(f.actions, includeOriginal: true)
    #expect(model.selectedSourceID == "original" && !model.canCopy && model.error != nil)
    #expect(model.snapshot?.sources.first { $0.kind == .saved }?.status == .available)
    #expect(f.reads.isEmpty)
  }

  @Test func invalidManifestAndUnsafeSelectionsFailBeforeAnyLocalWrite() async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    f.badPath = "../escape"
    let model = FileRecoveryModel(podId: "pod", actions: f.actions); await model.refresh(f.actions)
    #expect(model.snapshot == nil && model.error != nil && !model.canCopy)
    await model.copy(f.actions, chooseDirectory: { Issue.record("No picker for an invalid inventory"); return f.folder })
    #expect(f.reads.isEmpty)
    for path in ["../escape", "/root", "a//b", "a\\b", "a\nb"] { #expect(!RecoveryFilesSnapshot.safePath(path)) }
  }

  @Test func writerRejectsOverwriteAndDirectorySymlinkWithoutTouchingOutsideFiles() throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    let writer = try RecoveryFileWriter(parent: f.folder)
    let bytes = Data("selected copy".utf8), hash = RecoveryFileWriter.hash(bytes)
    try writer.write(bytes, relative: "same.txt", sha256: hash)
    #expect(throws: (any Error).self) { try writer.write(bytes, relative: "same.txt", sha256: hash) }
    let outside = f.folder.appendingPathComponent("outside", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(at: writer.directory.appendingPathComponent("escape"), withDestinationURL: outside)
    #expect(throws: (any Error).self) { try writer.write(bytes, relative: "escape/file.txt", sha256: hash) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
    #expect(try Data(contentsOf: writer.directory.appendingPathComponent("same.txt")) == bytes)
  }

  @Test func nativeStartReviewLeadsToOriginalFilesAndAnActualLocalCopy() async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }; f.includeOriginal = true
    var actions = PodActions.preview; actions.fileRecovery = f.actions; actions.sandboxRecovery = f.sandboxActions
    let model = FileRecoveryModel(podId: "pod", actions: f.actions)
    let sandbox = SandboxRecoveryModel(podId: "pod", actions: f.sandboxActions)
    let host = LaunchComposerHost(FileRecoveryView(actions: actions, model: model, sandbox: sandbox, chooseCopyDestination: { f.folder }), width: 820)
    host.window.orderBack(nil); defer { host.close() }
    try await host.wait { host.enabled("file-recovery-review-start") }
    #expect(f.startRequests.isEmpty && f.reads.isEmpty && sandbox.reason.isEmpty)
    try host.press("file-recovery-review-start")
    try await host.wait { !host.window.sheets.isEmpty }
    let sheet = try #require(host.window.sheets.first?.contentView)
    let controls = fileRecoveryAXNodes(sheet)
    let confirm = try #require(controls.first { fileRecoveryAX($0, "accessibilityIdentifier") as? String == "file-recovery-confirm-start" && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) })
    #expect(fileRecoveryAX(confirm, "accessibilityEnabled") as? Bool == false)
    #expect(controls.contains { (fileRecoveryAX($0, "accessibilityLabel") as? String ?? "").contains("audit note") || (fileRecoveryAX($0, "accessibilityValue") as? String ?? "").contains("audit note") })
    sandbox.reason = "Retrieve files missing from the saved copy"
    try await host.wait { fileRecoveryAX(confirm, "accessibilityEnabled") as? Bool == true }
    _ = confirm.perform(NSSelectorFromString("accessibilityPerformPress"))
    try await host.wait { f.startRequests.count == 1 && model.source?.id == "original" && !model.busy }
    #expect(f.startRequests.first?.reason == sandbox.reason && !f.startRequests[0].acknowledgeDataLoss)
    try await host.wait { host.has("file-recovery-file-only-original.txt") }
    try host.press("file-recovery-file-only-original.txt")
    try await host.wait { host.enabled("file-recovery-save") }
    try host.press("file-recovery-save")
    try await host.wait { model.savedCount == 1 && !model.busy }
    #expect(f.reads.last?.sourceId == "original" && f.startRequests.count == 1)
    let directory = try #require(model.directory)
    #expect(try Data(contentsOf: directory.appendingPathComponent("only-original.txt")) == f.originalData["only-original.txt"])
    try host.capture("original-after-start-and-save")
  }

  @Test(arguments: [680.0, 820.0], [false, true])
  func nativeFileSelectionAndSaveShowsConcreteResultsWithoutAnyMutationControl(width: Double, light: Bool) async throws {
    let f = RecoveryFilesTestFixture(); defer { f.clean() }
    var actions = PodActions.preview; actions.fileRecovery = f.actions
    let model = FileRecoveryModel(podId: "pod", actions: f.actions)
    let sandbox = SandboxRecoveryModel(podId: "pod", actions: .unavailable)
    let host = LaunchComposerHost(FileRecoveryView(actions: actions, model: model, sandbox: sandbox, chooseCopyDestination: { f.folder }), width: width, light: light)
    host.window.orderBack(nil); defer { host.close() }
    try await host.wait { host.has("file-recovery-file-notes.txt") }
    #expect(!host.enabled("file-recovery-save") && !host.has("sandbox-recovery-abandon"))
    #expect(!host.containsText("Recovery reason") && !host.containsText("I accept losing"))
    #expect(host.containsText("Saved host workspace") && host.containsText("never silently substituted"))
    try host.capture("files-before-\(Int(width))-\(light ? "light" : "dark")")
    try host.press("file-recovery-file-notes.txt")
    try await host.wait { host.enabled("file-recovery-save") }
    try host.press("file-recovery-save")
    try await host.wait { model.savedCount == 1 && !model.busy }
    #expect(model.results.first?.path == "notes.txt" && f.reads.count == 1)
    #expect(try Data(contentsOf: #require(model.directory).appendingPathComponent("notes.txt")) == f.data["notes.txt"])
    try host.capture("files-\(Int(width))-\(light ? "light" : "dark")")
  }
}

@MainActor final class RecoveryFilesTestFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("file-recovery-test-\(UUID().uuidString)", isDirectory: true)
  var current = true
  var reads: [RecoveryFileSelection] = []
  var data = ["notes.txt": Data("Saved notes\n".utf8), "nested/raw.bin": Data([0, 255, 128, 1])]
  var corrupt = false
  var includeOriginal = false
  var originalRunning = false
  var startRequests: [SandboxRecoveryRequest] = []
  let originalData = ["only-original.txt": Data("Original-only file bytes\n".utf8)]
  var failPath: String?
  var badPath: String?
  var onRead: (() -> Void)?
  init() { try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false) }
  func clean() { try? FileManager.default.removeItem(at: folder) }
  func snapshot(includeOriginalFiles: Bool = false) throws -> RecoveryFilesSnapshot {
    let files: [[String: Any]] = data.sorted { $0.key < $1.key }.map { ["path": badPath ?? $0.key, "size": $0.value.count, "modified": 0, "version": RecoveryFileWriter.hash($0.value)] }
    var sources: [[String: Any]] = [
      ["id": "saved-workspace", "kind": "saved", "label": "Saved host workspace", "binding": String(repeating: "a", count: 64), "status": "available", "detail": "Host copy may be older than the original.", "files": files, "truncated": false, "skippedEntries": 0]]
    if includeOriginal {
      let originalFiles: [[String: Any]] = originalRunning && includeOriginalFiles ? originalData.map { ["path": $0.key, "size": $0.value.count, "modified": 0, "version": RecoveryFileWriter.hash($0.value)] } : []
      sources.append(["id": "original", "kind": "original", "label": "Original environment", "binding": String(repeating: "b", count: 64), "sandboxId": "original", "status": originalRunning ? (includeOriginalFiles ? "available" : "ready") : "stopped", "detail": "Exact original, no implicit start.", "files": originalFiles, "truncated": false, "skippedEntries": 0])
    }
    return try decode(["version": 1, "podId": "pod", "generation": 3, "sources": sources,
      "limits": ["maxFileBytes": 5 * 1024 * 1024, "maxSelectionBytes": 50 * 1024 * 1024, "maxFiles": 2000], "excludes": [".git", ".env*", "symlinks"]])
  }
  func decode<T: Decodable>(_ value: [String: Any]) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }
  var sandboxActions: SandboxRecoveryActions {
    SandboxRecoveryActions(scope: "test", draftScope: folder.lastPathComponent, journalDirectory: folder.appendingPathComponent("journal"),
      load: { _ in
        try self.decode(["podId": "pod", "generation": 3, "currentUserId": "human", "operations": [], "wakeups": [],
          "resources": [["sandboxId": "original", "resourceKey": "test:original", "providerState": self.originalRunning ? "running" : "stopped",
            "observedAt": "2026-11-10T12:00:00Z", "pendingIntentIds": [], "startBlocked": NSNull(), "abandonBlocked": NSNull(), "abandonment": NSNull(), "observationError": NSNull()]]])
      }, submit: { _, request in
        guard request.action == "start", request.expectedGeneration == 3, request.expectedResourceKey == "test:original", request.sandboxId == "original" else { throw URLError(.badURL) }
        self.startRequests.append(request); self.originalRunning = true
        return try self.decode(["operation": ["id": request.id, "podId": "pod", "generation": 3, "sandboxId": "original", "resourceKey": "test:original",
          "action": "start", "userId": "human", "reason": request.reason, "createdAt": "2026-11-10T12:00:00Z", "completedAt": "2026-11-10T12:00:01Z"], "podDeleted": false, "cleanupError": NSNull()])
      })
  }
  var actions: FileRecoveryActions {
    FileRecoveryActions(scope: "test", isCurrent: { self.current }, load: { _, includeOriginal in try self.snapshot(includeOriginalFiles: includeOriginal) }, read: { _, selection in
      self.reads.append(selection); self.onRead?()
      if selection.path == self.failPath { throw DaemonError.notFound(selection.path) }
      guard let data = (selection.sourceId == "original" && self.originalRunning ? self.originalData : self.data)[selection.path] else { throw URLError(.badURL) }
      return try self.decode(["path": selection.path, "size": data.count, "encoding": "base64", "content": data.base64EncodedString(), "sha256": self.corrupt ? String(repeating: "b", count: 64) : RecoveryFileWriter.hash(data)])
    })
  }
}

@MainActor private func fileRecoveryAX(_ node: NSObject, _ key: String) -> Any? {
  let getter = key == "accessibilityEnabled" ? "isAccessibilityEnabled" : key
  return node.responds(to: NSSelectorFromString(getter)) || node.responds(to: NSSelectorFromString(key)) ? node.value(forKey: key) : nil
}
@MainActor private func fileRecoveryAXNodes(_ root: NSView) -> [NSObject] {
  var seen = Set<ObjectIdentifier>(), result: [NSObject] = []
  func visit(_ node: NSObject) {
    guard result.count < 5000, seen.insert(ObjectIdentifier(node)).inserted else { return }
    result.append(node)
    for child in fileRecoveryAX(node, "accessibilityChildren") as? [NSObject] ?? [] { visit(child) }
    if let view = node as? NSView { for child in view.subviews { visit(child) } }
  }
  visit(root); return result
}
