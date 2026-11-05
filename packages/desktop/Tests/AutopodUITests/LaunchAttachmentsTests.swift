import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@Suite @MainActor struct LaunchAttachmentsTests {
  @Test func collectsRelativeBinaryAssetsAndSkipsHiddenFiles() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let image = Data([0x89, 0x50, 0xff, 0x00])
    try image.write(to: root.appendingPathComponent("assets/wireframe.png"))
    try Data("<img src='assets/wireframe.png'>".utf8).write(to: root.appendingPathComponent("index.html"))
    try Data("secret".utf8).write(to: root.appendingPathComponent(".env"))
    let collected = try LocalReferenceCollector.collect([root])
    #expect(collected.count == 2)
    #expect(collected.first?.file.path == root.lastPathComponent + "/assets/wireframe.png")
    #expect(collected.first?.bytes == image)
    try Data("changed".utf8).write(to: root.appendingPathComponent("assets/wireframe.png"))
    #expect(collected.first?.bytes == image)
  }
  @Test func rejectsSymlinksAndDuplicateBasenamesAcrossSelections() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("design.html")
    try Data("Reference".utf8).write(to: file)
    let link = root.appendingPathComponent("link.html")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
    #expect(throws: (any Error).self) { try LocalReferenceCollector.collect([link]) }
    #expect(throws: (any Error).self) { try LocalReferenceCollector.collect([root]) }
    #expect(throws: (any Error).self) { try LocalReferenceCollector.collect([file, file]) }
  }
}
