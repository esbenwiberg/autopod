import CryptoKit
import Foundation

/// Frozen local bytes, not a URL that may change between preview and launch.
public struct InputAttachment: Equatable, Sendable, Identifiable {
  public var id: String { file.path }
  public let file: InputFileManifest
  public let bytes: Data
  public init(path: String, bytes: Data) throws {
    guard let mediaType = Self.mediaTypes[path.split(separator: ".").last?.lowercased() ?? ""],
      !path.isEmpty, path.count <= 240, path == path.precomposedStringWithCanonicalMapping,
      path.range(of: #"[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}:*?"<>|`]"#, options: .regularExpression) == nil,
      path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0.utf8.count <= 240 && !$0.hasPrefix(".") && !$0.hasSuffix(".") && !$0.hasSuffix(" ") }),
      path.split(separator: "/").count <= 16, bytes.count <= 10 * 1024 * 1024 else {
      throw DaemonError.badRequest("Unsupported or unsafe attachment. Use portable relative names and files up to 10 MiB.")
    }
    self.bytes = bytes
    self.file = InputFileManifest(path: path, mediaType: mediaType, byteLength: bytes.count,
      sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
  }
  public static func validate(_ files: [InputAttachment]) throws {
    let paths = files.map { $0.file.path.lowercased() }
    guard files.count <= 50, files.reduce(0, { $0 + $1.bytes.count }) <= 25 * 1024 * 1024,
      !paths.enumerated().contains(where: { index, path in paths.enumerated().contains { other, value in index != other && (path == value || path.hasPrefix(value + "/")) } }) else {
      throw DaemonError.badRequest("Reference limits: 50 files, 25 MiB total, and no colliding relative paths.")
    }
  }
  private static let mediaTypes = ["txt": "text/plain", "md": "text/markdown", "html": "text/html", "htm": "text/html", "css": "text/css", "js": "text/javascript", "json": "application/json", "yaml": "text/yaml", "yml": "text/yaml", "csv": "text/csv", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "pdf": "application/pdf", "drawio": "application/xml"]
}
public struct InputFileManifest: Codable, Equatable, Sendable {
  public let path: String
  public let mediaType: String
  public let byteLength: Int
  public let sha256: String
}
public struct InputBundleReference: Codable, Equatable, Sendable {
  public let id: String
  public let digest: String
  public let files: [InputFileManifest]
  public var configuration: ConfigurationJSON {
    .object(["id": .string(id), "digest": .string(digest), "files": .array(files.map { file in
      .object(["path": .string(file.path), "mediaType": .string(file.mediaType), "byteLength": .number(Double(file.byteLength)), "sha256": .string(file.sha256)])
    })])
  }
}
