import Foundation

/// Response row from GET /pods/:id/firewall-denials.
public struct FirewallDenialResponse: Codable, Identifiable, Sendable, Equatable {
  public let eventId: Int
  public let timestamp: String
  public let sni: String
  public let src: String

  public var id: Int { eventId }
}
