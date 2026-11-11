import AutopodClient
import CryptoKit
import Darwin
import Foundation

/// New private folder per copy; descriptor-relative writes, no symlink traversal or overwrite.
/// Saving a selected copy never grants archive/custody release or deletion authority.
final class RecoveryFileWriter {
  let directory: URL
  private let rootFD: Int32
  private let parent: URL
  private let scoped: Bool

  init(parent: URL) throws {
    self.parent = parent
    scoped = parent.startAccessingSecurityScopedResource()
    let canonical = parent.resolvingSymlinksInPath()
    let parentFD = Darwin.open(canonical.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parentFD >= 0 else {
      if scoped { parent.stopAccessingSecurityScopedResource() }
      throw Self.failure()
    }
    defer { Darwin.close(parentFD) }
    let name = "Autopod recovered files \(UUID().uuidString)"
    directory = canonical.appendingPathComponent(name, isDirectory: true)
    guard mkdirat(parentFD, name, 0o700) == 0 else {
      if scoped { parent.stopAccessingSecurityScopedResource() }
      throw Self.failure()
    }
    let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else {
      if scoped { parent.stopAccessingSecurityScopedResource() }
      throw Self.failure()
    }
    rootFD = fd
  }

  deinit {
    Darwin.close(rootFD)
    if scoped { parent.stopAccessingSecurityScopedResource() }
  }

  func write(_ data: Data, relative: String, sha256: String) throws {
    guard RecoveryFilesSnapshot.safePath(relative), RecoveryFilesSnapshot.isHash(sha256),
      data.count <= 5 * 1024 * 1024, Self.hash(data) == sha256 else { throw URLError(.badServerResponse) }
    let parts = relative.split(separator: "/").map(String.init)
    var fd = dup(rootFD)
    guard fd >= 0 else { throw Self.failure() }
    defer { Darwin.close(fd) }
    for part in parts.dropLast() {
      if mkdirat(fd, part, 0o700) != 0 && errno != EEXIST { throw Self.failure() }
      let child = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      guard child >= 0 else { throw Self.failure() }
      Darwin.close(fd); fd = child
    }
    guard let name = parts.last else { throw URLError(.badURL) }
    let file = openat(fd, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard file >= 0 else { throw Self.failure() }
    defer { Darwin.close(file) }
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(file, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw Self.failure() }
        offset += count
      }
    }
    guard fsync(file) == 0, lseek(file, 0, SEEK_SET) == 0 else { throw Self.failure() }
    var readback = Data(count: data.count)
    try readback.withUnsafeMutableBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.read(file, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw Self.failure() }
        offset += count
      }
    }
    guard Self.hash(readback) == sha256 else { throw URLError(.cannotDecodeContentData) }
  }
  static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  private static func failure() -> Error {
    POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }
}
