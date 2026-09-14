import Foundation

public struct WatcherBindingResponse: Codable, Identifiable, Equatable, Sendable {
  public var id: String
  public var revision: Int
  public var ownerUserId: String
  public var payload: [String: ConfigurationJSON]
  public var createdAt: String
  public var updatedAt: String
  public var name: String { payload["name"]?.string ?? id }
}
public struct WatcherBindingWrite: Encodable, Sendable {
  public var id: String?
  public var expectedRevision: Int?
  public var payload: [String: ConfigurationJSON]
  public init(id: String? = nil, expectedRevision: Int? = nil, payload: [String: ConfigurationJSON]) {
    self.id = id; self.expectedRevision = expectedRevision; self.payload = payload
  }
}
