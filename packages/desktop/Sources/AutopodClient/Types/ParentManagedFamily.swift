import Foundation

public struct ParentManagedFamily: Codable, Hashable, Sendable {
  public let parent: String
  public let run: String
  public let children: [ParentManagedChild]
  public let review: ParentManagedReview?
}

public struct ParentManagedReview: Codable, Hashable, Sendable {
  public enum Status: String, Codable, Hashable, Sendable {
    case waiting, reserved, checks, independentReview, ready, failed, unknown, unavailable
    case notSent = "not-sent"
    case notConfigured = "not-configured"
    case candidateUnavailable = "candidate-unavailable"
    case unsupported

    public init(from decoder: any Decoder) throws {
      let container = try decoder.singleValueContainer()
      self = Status(rawValue: try container.decode(String.self)) ?? .unsupported
    }
  }

  public let status: Status
  public let evidenceDigest: String?
  public let commit: String?
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
  public let exitReason: String?
  public let exitCode: Int?
  public let collectionStatus: String?
}
