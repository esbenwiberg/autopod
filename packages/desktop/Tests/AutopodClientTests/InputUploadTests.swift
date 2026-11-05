import AutopodClient
import Foundation
import Testing

@Suite(.serialized) struct InputUploadTests {
  @Test func uploadsBinaryBytesAndReusesAnExactUploadKey() async throws {
    InputUploadProtocol.reset()
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [InputUploadProtocol.self]
    let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
    let api = DaemonAPI(baseURL: URL(string: "https://daemon.invalid")!, token: "operator", session: session)
    let bytes = Data([0x89, 0x50, 0xff, 0x00])
    let attachment = try InputAttachment(path: "wireframe.png", bytes: bytes)
    let first = try await api.uploadInputs([attachment])
    let second = try await api.uploadInputs([attachment])
    #expect(first == second)
    let requests = InputUploadProtocol.captured()
    let puts = requests.filter { $0.httpMethod == "PUT" }
    #expect(puts.count == 2)
    #expect(puts.allSatisfy { $0.httpBody == bytes && $0.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream" })
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer operator" })
    let creates = try requests.filter { $0.url?.path == "/input-bundles" }.map { try JSONDecoder().decode(ConfigurationJSON.self, from: $0.httpBody ?? Data()) }
    #expect(creates.count == 2)
    #expect(creates[0]["requestKey"] == creates[1]["requestKey"])
    #expect(first.files.first?.sha256 == attachment.file.sha256)
  }
}
private final class InputUploadProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var requests: [URLRequest] = []
  nonisolated(unsafe) private static var bundle: [String: ConfigurationJSON] = [:]
  static func reset() { lock.lock(); defer { lock.unlock() }; requests = []; bundle = [:] }
  static func captured() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      Self.lock.lock()
      var captured = request
      if captured.httpBody == nil, let stream = captured.httpBodyStream {
        stream.open(); defer { stream.close() }
        var bytes = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count < 0 { throw URLError(.cannotDecodeRawData) }
          if count == 0 { break }
          bytes.append(contentsOf: buffer.prefix(count))
        }
        captured.httpBody = bytes
      }
      Self.requests.append(captured)
      if request.url?.path == "/input-bundles" {
        let input = try JSONDecoder().decode(ConfigurationJSON.self, from: captured.httpBody ?? Data())
        Self.bundle = ["id": .string("inputs-11111111-1111-4111-a111-111111111111"), "digest": .string(String(repeating: "a", count: 64)), "files": input["files"] ?? .array([]), "status": .string("uploading")]
      }
      if request.url?.path.hasSuffix("/seal") == true { Self.bundle["status"] = .string("sealed") }
      let body = try JSONEncoder().encode(ConfigurationJSON.object(Self.bundle))
      Self.lock.unlock()
      let code = request.httpMethod == "PUT" ? 204 : 200
      let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      if code != 204 { client?.urlProtocol(self, didLoad: body) }
      client?.urlProtocolDidFinishLoading(self)
    } catch { Self.lock.unlock(); client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
