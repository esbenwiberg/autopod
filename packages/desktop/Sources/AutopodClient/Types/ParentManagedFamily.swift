import Foundation

public struct ParentManagedFamily: Codable, Hashable, Sendable {
  public let parent: String
  public let run: String
  public let children: [ParentManagedChild]
}

public struct ParentManagedChild: Codable, Hashable, Sendable {
  public enum Status: String, Codable, Hashable, Sendable {
    case reserved
    case started
    case exited
    case unknown

    public init(from decoder: any Decoder) throws {
      let container = try decoder.singleValueContainer()
      self = Status(rawValue: (try? container.decode(String.self)) ?? "") ?? .unknown
    }
  }

  public let requestKey: String
  public let parentAttempt: String
  public let child: String?
  public let status: Status
}
