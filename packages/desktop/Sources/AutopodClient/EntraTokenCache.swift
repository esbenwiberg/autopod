import Foundation

public struct EntraCachedToken: Codable, Sendable, Equatable {
  public let accessToken: String
  public let refreshToken: String?
  public let expiresAt: Date
  public let scope: String?

  public init(accessToken: String, refreshToken: String?, expiresAt: Date, scope: String?) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.expiresAt = expiresAt
    self.scope = scope
  }

  public func isValid(now: Date = Date(), refreshBuffer: TimeInterval = 300) -> Bool {
    expiresAt.timeIntervalSince(now) > refreshBuffer
  }
}
