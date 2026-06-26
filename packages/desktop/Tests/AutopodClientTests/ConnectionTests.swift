import Foundation
import Testing
@testable import AutopodClient

@Test func daemonConnectionLabel() {
  let conn = DaemonConnection(
    name: "Local",
    url: URL(string: "http://localhost:3000")!
  )
  #expect(conn.label == "localhost:3000")
  #expect(conn.name == "Local")
}

@Test func daemonConnectionLabelWithoutPort() {
  let conn = DaemonConnection(
    name: "Remote",
    url: URL(string: "https://daemon.example.com")!
  )
  #expect(conn.label == "daemon.example.com")
}

@Test func daemonConnectionDefaultsLegacyAuthKindToManualToken() throws {
  let id = UUID()
  let data = """
  {
    "id": "\(id.uuidString)",
    "name": "Legacy",
    "url": "https://daemon.example.com"
  }
  """.data(using: .utf8)!

  let conn = try JSONDecoder().decode(DaemonConnection.self, from: data)

  #expect(conn.id == id)
  #expect(conn.authKind == .manualToken)
}

@Test func daemonConnectionNormalizesBareRemoteHostToHTTPS() {
  let url = DaemonConnection.normalizedURL(
    from: " autopod-daemon-ewi.swedencentral.cloudapp.azure.com "
  )

  #expect(url?.absoluteString == "https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com")
}

@Test func daemonConnectionNormalizesBareLocalHostToHTTP() {
  let url = DaemonConnection.normalizedURL(from: "localhost:3100")

  #expect(url?.absoluteString == "http://localhost:3100")
}

@Test func entraCachedTokenHonorsRefreshBuffer() {
  let token = EntraCachedToken(
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date(timeIntervalSince1970: 1_000),
    scope: "scope"
  )

  #expect(token.isValid(now: Date(timeIntervalSince1970: 600), refreshBuffer: 300))
  #expect(!token.isValid(now: Date(timeIntervalSince1970: 750), refreshBuffer: 300))
}

@Test func hostedDaemonATSExceptionIsRemovedAndNativeRedirectSchemeIsRegistered() throws {
  let packageRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let plistURL = packageRoot.appendingPathComponent("Autopod/Info.plist")
  let data = try Data(contentsOf: plistURL)
  let plist = try #require(
    PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
  )

  let ats = try #require(plist["NSAppTransportSecurity"] as? [String: Any])
  #expect(ats["NSExceptionDomains"] == nil)
  #expect(ats["NSAllowsLocalNetworking"] as? Bool == true)

  let urlTypes = try #require(plist["CFBundleURLTypes"] as? [[String: Any]])
  let schemes = urlTypes.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }
  #expect(schemes.contains("msauth.com.autopod.desktop"))
}

@Test func createSessionRequestOmitsNilFields() throws {
  let req = CreateSessionRequest(
    profileName: "my-app",
    task: "Build feature"
  )
  let data = try JSONEncoder().encode(req)
  let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

  #expect(dict["profileName"] as? String == "my-app")
  #expect(dict["task"] as? String == "Build feature")
  // Nil optional fields should not appear in JSON
  #expect(dict["model"] == nil)
  #expect(dict["branch"] == nil)
  #expect(dict["outputMode"] == nil)
}

@Test func keychainRoundTrip() throws {
  let id = UUID()
  let token = "test-token-\(id.uuidString.prefix(8))"

  // Save
  try KeychainHelper.save(token: token, for: id)

  // Load
  let loaded = KeychainHelper.load(for: id)
  #expect(loaded == token)

  // Delete
  KeychainHelper.delete(for: id)
  let afterDelete = KeychainHelper.load(for: id)
  #expect(afterDelete == nil)
}
