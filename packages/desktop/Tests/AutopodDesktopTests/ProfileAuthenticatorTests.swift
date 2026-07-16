import Foundation
import Testing
@testable import AutopodDesktop
import AutopodClient

private final class PiAuthURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var requests: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.requests.append(request)
    let path = request.url?.path ?? ""
    let responseBody: String
    if path.hasPrefix("/provider-accounts/") {
      responseBody = """
      {
        "id": "team-pi",
        "name": "Team Pi",
        "provider": "pi",
        "credentials": null,
        "hasCredentials": true,
        "lastAuthenticatedAt": "2026-07-16T00:00:00Z",
        "lastUsedAt": null,
        "createdAt": "2026-07-16T00:00:00Z",
        "updatedAt": "2026-07-16T00:00:00Z"
      }
      """
    } else {
      responseBody = """
      {
        "name": "pi-profile",
        "defaultRuntime": "pi",
        "modelProvider": "pi",
        "version": 1,
        "createdAt": "2026-07-16T00:00:00Z",
        "updatedAt": "2026-07-16T00:00:00Z"
      }
      """
    }
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

private func bodyData(from request: URLRequest) -> Data? {
  if let body = request.httpBody {
    return body
  }
  guard let stream = request.httpBodyStream else {
    return nil
  }

  stream.open()
  defer { stream.close() }

  var data = Data()
  let bufferSize = 4096
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
  defer { buffer.deallocate() }

  while stream.hasBytesAvailable {
    let read = stream.read(buffer, maxLength: bufferSize)
    if read <= 0 { break }
    data.append(buffer, count: read)
  }
  return data
}

@Suite(.serialized)
struct ProfileAuthenticatorTests {
  private func makeAuthenticator() -> ProfileAuthenticator {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PiAuthURLProtocol.self]
    PiAuthURLProtocol.requests = []
    let api = DaemonAPI(
      baseURL: URL(string: "https://desktop-auth.test")!,
      token: "test-token",
      session: URLSession(configuration: configuration)
    )
    return ProfileAuthenticator(api: api)
  }

  @Test func selectedPiProviderIsTheOnlyCredentialPatched() async throws {
    let authenticator = makeAuthenticator()
    let authData = Data(#"{"anthropic":{"accessToken":"selected-secret"},"openai-codex":{"accessToken":"other-secret"}}"#.utf8)

    _ = try await authenticator.authenticatePi(
      profileName: "pi-profile",
      providerId: .anthropic,
      authData: authData
    )

    let request = try #require(PiAuthURLProtocol.requests.first)
    let body = try #require(bodyData(from: request))
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    let credentials = try #require(json["providerCredentials"] as? [String: Any])
    let credential = try #require(credentials["credential"] as? [String: Any])
    #expect(json["defaultRuntime"] as? String == "pi")
    #expect(json["modelProvider"] as? String == "pi")
    #expect(credentials["provider"] as? String == "pi")
    #expect(credentials["providerId"] as? String == "anthropic")
    #expect(credential["accessToken"] as? String == "selected-secret")
    #expect(!String(data: body, encoding: .utf8)!.contains("other-secret"))
  }

  @Test func selectedPiProviderCanPatchProviderAccountCredentials() async throws {
    let authenticator = makeAuthenticator()
    let authData = Data(#"{"github-copilot":{"token":"selected-secret"},"anthropic":{"accessToken":"other-secret"}}"#.utf8)

    _ = try await authenticator.authenticatePiProviderAccount(
      accountId: "team-pi",
      providerId: .githubCopilot,
      authData: authData
    )

    let request = try #require(PiAuthURLProtocol.requests.first)
    let body = try #require(bodyData(from: request))
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    let credentials = try #require(json["credentials"] as? [String: Any])
    let credential = try #require(credentials["credential"] as? [String: Any])
    #expect(request.url?.path == "/provider-accounts/team-pi")
    #expect(credentials["provider"] as? String == "pi")
    #expect(credentials["providerId"] as? String == "github-copilot")
    #expect(credential["token"] as? String == "selected-secret")
    #expect(!String(data: body, encoding: .utf8)!.contains("other-secret"))
  }

  @Test func malformedOrWrongPiProviderDoesNotPatch() async {
    let authenticator = makeAuthenticator()
    let authData = Data(#"{"openai-codex":{"accessToken":"wrong-provider"}}"#.utf8)

    await #expect(throws: ProfileAuthenticator.AuthError.self) {
      _ = try await authenticator.authenticatePi(
        profileName: "pi-profile",
        providerId: .anthropic,
        authData: authData
      )
    }
    #expect(PiAuthURLProtocol.requests.isEmpty)
  }

  @Test func cancellationWaitsForTerminalBeforeDeletingIsolatedCredentials() throws {
    let tag = UUID().uuidString
    let agentDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("pi-auth-test-\(tag)")
    let cancellationPath = FileManager.default.temporaryDirectory
      .appendingPathComponent("pi-auth-test-cancel-\(tag)")
    try FileManager.default.createDirectory(at: agentDir, withIntermediateDirectories: true)
    try Data("secret".utf8).write(to: agentDir.appendingPathComponent("auth.json"))

    DispatchQueue.global().async {
      while !FileManager.default.fileExists(atPath: cancellationPath.path) {
        Thread.sleep(forTimeInterval: 0.01)
      }
      FileManager.default.createFile(
        atPath: agentDir.appendingPathComponent(".auth-status").path,
        contents: Data("130".utf8)
      )
    }

    ProfileAuthenticator.cancelPiLogin(
      agentDir: agentDir,
      cancellationPath: cancellationPath
    )

    #expect(!FileManager.default.fileExists(atPath: agentDir.path))
    #expect(!FileManager.default.fileExists(atPath: cancellationPath.path))
  }

  @Test func cancellationMarkerSurvivesDelayedTerminalLaunch() throws {
    let tag = UUID().uuidString
    let agentDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("pi-auth-delayed-test-\(tag)")
    let cancellationPath = FileManager.default.temporaryDirectory
      .appendingPathComponent("pi-auth-delayed-test-cancel-\(tag)")
    try FileManager.default.createDirectory(at: agentDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: cancellationPath) }

    ProfileAuthenticator.cancelPiLogin(
      agentDir: agentDir,
      cancellationPath: cancellationPath
    )

    #expect(!FileManager.default.fileExists(atPath: agentDir.path))
    #expect(FileManager.default.fileExists(atPath: cancellationPath.path))
  }
}
