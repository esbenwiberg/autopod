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
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"name":"pi-profile"}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
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
    let body = try #require(request.httpBody)
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
}
