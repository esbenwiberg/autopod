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
