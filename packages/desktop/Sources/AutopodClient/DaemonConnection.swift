import Foundation

/// Persisted daemon connection metadata.
/// Token is stored separately in Keychain, keyed by `id`.
public struct DaemonConnection: Codable, Sendable, Identifiable {
  public var id: UUID
  public var name: String
  public var url: URL

  public init(id: UUID = UUID(), name: String, url: URL) {
    self.id = id
    self.name = name
    self.url = url
  }

  /// Display label for the connection (e.g. "localhost:3000")
  public var label: String {
    if let host = url.host {
      let port = url.port.map { ":\($0)" } ?? ""
      return "\(host)\(port)"
    }
    return url.absoluteString
  }
}

// MARK: - UserDefaults persistence

public enum ConnectionStore {
  private static let key = "autopod.connections"
  private static let activeKey = "autopod.activeConnectionId"

  public static func loadAll() -> [DaemonConnection] {
    guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([DaemonConnection].self, from: data)) ?? []
  }

  public static func save(_ connections: [DaemonConnection]) {
    let data = try? JSONEncoder().encode(connections)
    UserDefaults.standard.set(data, forKey: key)
  }

  // Token fallback — UserDefaults for when Keychain isn't available (SPM/unsigned builds)
  public static func saveToken(_ token: String, for id: UUID) {
    UserDefaults.standard.set(token, forKey: "autopod.token.\(id.uuidString)")
  }

  public static func loadToken(for id: UUID) -> String? {
    UserDefaults.standard.string(forKey: "autopod.token.\(id.uuidString)")
  }

  public static func deleteToken(for id: UUID) {
    UserDefaults.standard.removeObject(forKey: "autopod.token.\(id.uuidString)")
  }

  public static func activeConnectionId() -> UUID? {
    guard let str = UserDefaults.standard.string(forKey: activeKey) else { return nil }
    return UUID(uuidString: str)
  }

  public static func setActiveConnectionId(_ id: UUID?) {
    UserDefaults.standard.set(id?.uuidString, forKey: activeKey)
  }
}
