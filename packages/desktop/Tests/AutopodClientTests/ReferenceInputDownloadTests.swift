import Foundation
import Testing
@testable import AutopodClient
import AutopodDesktop

@Suite(.serialized) struct ReferenceInputDownloadTests {
  private func fixture() throws -> (InputBundleReference, Data) {
    let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])
    let file = try InputAttachment(path: "screens/reference.png", bytes: bytes).file
    return (InputBundleReference(id: "inputs-12345678-1234-1234-1234-123456789abc", digest: String(repeating: "a", count: 64), files: [file]), bytes)
  }

  @Test func downloadsOriginalBinaryWithFreshAuthenticationAndVerifiesManifest() async throws {
    let (bundle, bytes) = try fixture()
    ReferenceInputURLProtocol.handler = { request in
      #expect(request.url?.path == "/prefix/input-bundles/\(bundle.id)/files/0")
      #expect(request.httpMethod == "GET")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-token")
      #expect(request.value(forHTTPHeaderField: "Accept") == "application/octet-stream")
      #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
      return (200, bytes)
    }
    defer { ReferenceInputURLProtocol.handler = nil }
    #expect(try await client().getInputFile(bundle, index: 0) == bytes)
  }

  @Test(arguments: ["size", "hash", "missing", "unauthorized", "forbidden"])
  func rejectsUnavailableOrChangedBytes(scenario: String) async throws {
    let (bundle, bytes) = try fixture()
    ReferenceInputURLProtocol.handler = { _ in
      switch scenario {
      case "size": return (200, bytes + Data([0]))
      case "hash": return (200, Data(repeating: 0, count: bytes.count))
      case "missing": return (404, Data())
      case "unauthorized": return (401, Data())
      default: return (403, Data(#"{"message":"Not your reference"}"#.utf8))
      }
    }
    defer { ReferenceInputURLProtocol.handler = nil }
    await #expect(throws: (any Error).self) { try await client().getInputFile(bundle, index: 0) }
  }

  @Test func rejectsBadIndicesAndBundlePathsBeforeAuthenticationOrNetwork() async throws {
    let (bundle, _) = try fixture()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ReferenceInputURLProtocol.self]
    let api = DaemonAPI(baseURL: URL(string: "https://references.invalid")!, initialToken: "", session: URLSession(configuration: configuration), tokenProvider: {
      Issue.record("Invalid metadata must not request a token"); return "token"
    })
    for index in [-1, 1, 50] {
      await #expect(throws: (any Error).self) { try await api.getInputFile(bundle, index: index) }
    }
    let invalid = InputBundleReference(id: "../pods/private", digest: bundle.digest, files: bundle.files)
    await #expect(throws: (any Error).self) { try await api.getInputFile(invalid, index: 0) }
  }

  @Test func readsFrozenManifestAndHandlesOldPodsWithoutInputs() throws {
    let (bundle, _) = try fixture()
    let value: ConfigurationJSON = .object(["work": .object(["inputBundle": bundle.configuration])])
    let launch = try JSONDecoder().decode(EffectiveLaunchPreview.self, from: JSONEncoder().encode(value))
    #expect(try launch.referenceInputBundle() == bundle)
    for json in ["{}", #"{"work":{}}"#, #"{"work":{"inputBundle":null}}"#] {
      let old = try JSONDecoder().decode(EffectiveLaunchPreview.self, from: Data(json.utf8))
      #expect(try old.referenceInputBundle() == nil)
    }
    let invalid = try JSONDecoder().decode(EffectiveLaunchPreview.self, from: Data(#"{"work":{"inputBundle":{"id":"broken"}}}"#.utf8))
    #expect(throws: (any Error).self) { try invalid.referenceInputBundle() }
    #expect(throws: (any Error).self) {
      try InputBundleReference(id: bundle.id, digest: bundle.digest, files: Array(repeating: bundle.files[0], count: 51)).validateManifest()
    }
  }

  @MainActor @Test(arguments: ["configuration", "file"], ["obsolete", "held", "same-endpoint", "success"])
  func connectionOwnershipRejectsOldReads(operation: String, stage: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      let bytes = Data("original reference".utf8)
      let file = try InputAttachment(path: "reference.txt", bytes: bytes).file
      let bundle = InputBundleReference(id: "inputs-12345678-1234-1234-1234-123456789abc", digest: String(repeating: "a", count: 64), files: [file])
      let store = LaunchConfigurationStore()
      store.configure(api: f.apiA)
      let actions = store.actions(onCreated: { _ in })
      if stage == "obsolete" { store.disconnect() }
      let task = f.startResult {
        do {
          if operation == "file" { return String(decoding: try await actions.readInputFile(bundle, 0), as: UTF8.self) }
          let config = try await actions.readLaunch("pod")
          return try config.referenceInputBundle()?.id
        } catch {
          #expect(error.localizedDescription.contains("Connection changed"))
          return nil
        }
      }
      if stage != "obsolete" {
        let path = operation == "file" ? "/input-bundles/\(bundle.id)/files/0" : "/pods/pod/configuration"
        let request = try await f.next(f.a, path)
        if stage == "held" { store.configure(api: f.apiB) }
        if stage == "same-endpoint" { store.configure(api: f.apiA) }
        let body = operation == "file" ? String(decoding: bytes, as: UTF8.self) : ConfigurationJSON.object(["work": .object(["inputBundle": bundle.configuration])]).formatted()
        request.respond(body: body)
      }
      let result = await task.value
      #expect(result == (stage == "success" ? (operation == "file" ? "original reference" : bundle.id) : nil))
      #expect(f.a.requests.count == (stage == "obsolete" ? 0 : 1) && f.b.requests.isEmpty)
    }
  }

  private func client() -> DaemonAPI {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ReferenceInputURLProtocol.self]
    return DaemonAPI(baseURL: URL(string: "https://references.invalid/prefix")!, initialToken: "stale", session: URLSession(configuration: configuration), tokenProvider: { "fresh-token" })
  }
}

private final class ReferenceInputURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "references.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler else { client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return }
    let (status, data) = handler(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/octet-stream"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
