import Foundation

/// A single entry from the daemon's action catalog (`GET /actions/catalog`).
public struct ActionCatalogEntry: Codable, Sendable, Identifiable {
  public var id: String { name }
  public let name: String
  public let description: String
  public let group: String
}
