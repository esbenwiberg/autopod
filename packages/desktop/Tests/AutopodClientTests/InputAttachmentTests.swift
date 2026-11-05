import AutopodClient
import Foundation
import Testing

@Suite struct InputAttachmentTests {
  @Test func preservesExactBinaryBytesAndPortableManifest() throws {
    let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])
    let attachment = try InputAttachment(path: "design/wireframe.png", bytes: bytes)
    #expect(attachment.bytes == bytes)
    #expect(attachment.file.byteLength == bytes.count)
    #expect(attachment.file.mediaType == "image/png")
    #expect(attachment.file.sha256.count == 64)
  }
  @Test func rejectsUnsafeNamesAndCollisions() throws {
    for name in ["../x.html", "/x.html", "a//x.html", "C:/x.html", ".env", "x\ny.html", "a\\x.html"] {
      #expect(throws: (any Error).self) { try InputAttachment(path: name, bytes: Data()) }
    }
    let a = try InputAttachment(path: "design.html", bytes: Data())
    let b = try InputAttachment(path: "DESIGN.HTML", bytes: Data())
    #expect(throws: (any Error).self) { try InputAttachment.validate([a, b]) }
    #expect(throws: (any Error).self) { try InputAttachment(path: "large.png", bytes: Data(count: 10 * 1024 * 1024 + 1)) }
  }
  @Test func launchJournalRetainsOnlySealedManifestNotLocalBytes() throws {
    var request = ComposableLaunchRequest(repositoryId: "repo", task: "Build the reference")
    request.work = ["inputBundle": .object(["id": .string("inputs-test"), "digest": .string(String(repeating: "a", count: 64)), "files": .array([.object(["path": .string("wireframe.html"), "byteLength": .number(8), "mediaType": .string("text/html"), "sha256": .string(String(repeating: "b", count: 64))])])])]
    let bytes = try JSONEncoder().encode(request)
    #expect(try ComposableLaunchRequest.decodeJSON(bytes) == request)
    #expect(!String(decoding: bytes, as: UTF8.self).contains("base64"))
    #expect(!String(decoding: bytes, as: UTF8.self).contains("/Users/"))
  }
}
