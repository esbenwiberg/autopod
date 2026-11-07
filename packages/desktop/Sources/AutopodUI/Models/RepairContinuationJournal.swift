import CryptoKit
import Darwin
import Foundation
import AutopodClient

/// One immutable request per daemon/pod. A lost response never permits replacement.
internal struct RepairContinuationJournal<Value: Codable & Equatable> {
  let url: URL

  init(scope: String, podId: String, directory: URL?) {
    let identity = Data("\(scope.utf8.count):\(scope)\(podId)".utf8)
    let key = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    let folder = directory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/repair-continuation-v1", isDirectory: true)
    url = folder.appendingPathComponent("\(key).json")
  }

  func load() throws -> Value? {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if fd < 0 {
      if errno == ENOENT { return nil }
      throw failure("Cannot read saved repair request")
    }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? file.close() }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
      metadata.st_size > 0, metadata.st_size <= 131_072 else {
      throw failure("Saved repair request is not a bounded regular file")
    }
    do {
      guard let data = try file.read(upToCount: 131_073), data.count <= 131_072 else {
        throw failure("Saved repair request exceeds its bound")
      }
      return try JSONDecoder().decode(Value.self, from: data)
    } catch {
      throw failure("Saved repair request is unreadable; retain it for inspection")
    }
  }

  func save(_ value: Value) throws {
    if let saved = try load() {
      guard saved == value else { throw failure("A different saved repair request owns this pod") }
      return
    }
    let folder = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let data = try JSONEncoder().encode(value)
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw failure("Could not exclusively preserve repair request; reopen and observe") }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? file.close() }
    // A partial/failed write remains a blocking unreadable journal, never a new request.
    try file.write(contentsOf: data)
    try file.synchronize()
    let directoryFD = open(folder.path, O_RDONLY | O_DIRECTORY)
    guard directoryFD >= 0 else { throw failure("Could not synchronize repair journal directory") }
    defer { close(directoryFD) }
    guard fsync(directoryFD) == 0 else { throw failure("Could not synchronize repair journal directory") }
  }

  private func failure(_ message: String) -> DaemonError {
    .badRequest("\(message). No new request was sent; inspect the existing request.")
  }
}
