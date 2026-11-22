import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop

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

@Test func previewOwnerRequiresExplicitConnectedPreviewAndAnExactPrivateOrigin() {
  let valid = "--preview-owner-url=http://127.0.0.1:43144"
  #expect(DesktopIdentity.previewOwnerURL(isConnectedPreview: true, arguments: ["app", valid])?.port == 43144)
  #expect(DesktopIdentity.previewOwnerURL(isConnectedPreview: false, arguments: ["app", valid]) == nil)
  #expect(DesktopIdentity.previewOwnerURL(isConnectedPreview: true, arguments: ["app", valid, valid]) == nil)
  for origin in [
    "http://127.0.0.1:3100", "http://127.0.0.1", "https://127.0.0.1:43144",
    "http://localhost:43144", "http://127.0.0.1.example.com:43144",
    "http://user@127.0.0.1:43144", "http://127.0.0.1:43144/other",
    "http://127.0.0.1:43144?next=remote", "http://127.0.0.1:43144#fragment",
  ] {
    #expect(DesktopIdentity.previewOwnerURL(isConnectedPreview: true, arguments: ["--preview-owner-url=" + origin]) == nil)
  }
}

@Test func previewOwnerMicrosoftCacheDoesNotReuseOrdinaryOrOtherPortAccounts() {
  let ordinary = EntraDesktopAuthConfiguration()
  let first = EntraDesktopAuthConfiguration(previewOwnerPort: 43144)
  let second = EntraDesktopAuthConfiguration(previewOwnerPort: 43145)
  #expect(Set([ordinary.cacheAccount, first.cacheAccount, second.cacheAccount]).count == 3)
  #expect(first.redirectURI == ordinary.redirectURI)
  #expect(first.scope == ordinary.scope)
}

@MainActor
@Test func ordinaryConnectionManagerRejectsPreviewOwnerAuth() async {
  let manager = ConnectionManager(restoreConnection: false)
  let url = URL(string: "http://127.0.0.1:43144")!
  let result = await manager.testConnection(url: url, token: "not-used", authKind: .previewOwner)
  guard case .failure(.badRequest) = result else {
    Issue.record("Ordinary app accepted Preview-only credentials")
    return
  }
  await #expect(throws: DaemonError.self) { try await manager.signInPreviewOwner(at: url) }
  await #expect(throws: DaemonError.self) {
    try await manager.addAndConnect(name: "Candidate", url: url, token: "not-used", authKind: .previewOwner)
  }
  #expect(manager.connection == nil)
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

@MainActor
@Test func launchDeepLinkSkipsSavedConnectionRestoreAtStartup() {
  let defaults = UserDefaults.standard
  let connectionsKey = "autopod.connections"
  let activeKey = "autopod.activeConnectionId"
  let pendingKey = "autopod.pendingDeepLink"
  let previousConnections = defaults.data(forKey: connectionsKey)
  let previousActive = defaults.string(forKey: activeKey)
  let previousPending = defaults.string(forKey: pendingKey)
  defer {
    restore(previousConnections, forKey: connectionsKey, in: defaults)
    restore(previousActive, forKey: activeKey, in: defaults)
    restore(previousPending, forKey: pendingKey, in: defaults)
  }

  let saved = DaemonConnection(
    name: "Old",
    url: URL(string: "https://old.example.com")!,
    authKind: .manualToken
  )
  ConnectionStore.save([saved])
  ConnectionStore.setActiveConnectionId(saved.id)
  defaults.set(
    "autopod://connect?url=http://127.0.0.1:9&name=Fresh&token=fresh-token",
    forKey: pendingKey
  )

  let manager = ConnectionManager()

  #expect(manager.connection?.id != saved.id)
  #expect(defaults.string(forKey: pendingKey) == nil)
}

@Test func cliEntraAccessTokenUsesUnexpiredCliCredentials() {
  let data = """
  {
    "accessToken": "Bearer cli-token",
    "refreshToken": "",
    "expiresAt": "2026-06-28T22:30:00.000Z",
    "userId": "u",
    "displayName": "User",
    "email": "user@example.com",
    "roles": []
  }
  """.data(using: .utf8)!

  let token = ConnectionManager.cliEntraAccessToken(
    from: data,
    now: ISO8601DateFormatter().date(from: "2026-06-28T22:00:00Z")!
  )

  #expect(token == "cli-token")
}

@Test func cliEntraAccessTokenRejectsCredentialsInsideRefreshBuffer() {
  let data = """
  {
    "accessToken": "cli-token",
    "refreshToken": "",
    "expiresAt": "2026-06-28T22:03:00.000Z",
    "userId": "u",
    "displayName": "User",
    "email": "user@example.com",
    "roles": []
  }
  """.data(using: .utf8)!

  let token = ConnectionManager.cliEntraAccessToken(
    from: data,
    now: ISO8601DateFormatter().date(from: "2026-06-28T22:00:00Z")!
  )

  #expect(token == nil)
}

private func restore(_ data: Data?, forKey key: String, in defaults: UserDefaults) {
  if let data {
    defaults.set(data, forKey: key)
  } else {
    defaults.removeObject(forKey: key)
  }
}

private func restore(_ value: String?, forKey key: String, in defaults: UserDefaults) {
  if let value {
    defaults.set(value, forKey: key)
  } else {
    defaults.removeObject(forKey: key)
  }
}
