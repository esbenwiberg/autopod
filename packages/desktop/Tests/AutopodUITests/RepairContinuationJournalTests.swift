import Foundation
import Testing
@testable import AutopodUI

@Suite @MainActor struct RepairContinuationJournalTests {
  private struct Request: Codable, Equatable { let id: String; let reason: String }

  @Test func journalIsPrivateImmutableAndDaemonScoped() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = RepairContinuationJournal<Request>(scope: "daemon-a", podId: "pod", directory: directory)
    let other = RepairContinuationJournal<Request>(scope: "daemon-b", podId: "pod", directory: directory)
    let request = Request(id: "stable", reason: "Preserve original work")
    #expect(try journal.load() == nil)
    try journal.save(request)
    #expect(try journal.load() == request)
    try journal.save(request)
    #expect(try other.load() == nil)
    #expect(throws: (any Error).self) { try journal.save(Request(id: "new", reason: request.reason)) }
    #expect(try journal.load() == request)
    let attributes = try FileManager.default.attributesOfItem(atPath: journal.url.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let folder = try FileManager.default.attributesOfItem(atPath: directory.path)
    #expect((folder[.posixPermissions] as? NSNumber)?.intValue == 0o700)
  }

  @Test func corruptOrSymlinkedJournalCannotBeOverwritten() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = RepairContinuationJournal<Request>(scope: "daemon", podId: "pod", directory: directory)
    let damaged = Data("not json".utf8)
    try damaged.write(to: journal.url)
    #expect(throws: (any Error).self) { try journal.load() }
    #expect(throws: (any Error).self) { try journal.save(Request(id: "new", reason: "Keep original")) }
    #expect(try Data(contentsOf: journal.url) == damaged)
    try FileManager.default.removeItem(at: journal.url)
    let target = directory.appendingPathComponent("target")
    try damaged.write(to: target)
    try FileManager.default.createSymbolicLink(at: journal.url, withDestinationURL: target)
    #expect(throws: (any Error).self) { try journal.load() }
    #expect(throws: (any Error).self) { try journal.save(Request(id: "new", reason: "Keep original")) }
    #expect(try Data(contentsOf: target) == damaged)
  }
}
