import Foundation

/// A single entry from the daemon's builtin skills directory (`GET /api/skills`).
public struct BuiltinSkillEntry: Codable, Sendable, Identifiable {
  public var id: String { name }
  public let name: String
  public let description: String?

  public init(name: String, description: String? = nil) {
    self.name = name
    self.description = description
  }
}
