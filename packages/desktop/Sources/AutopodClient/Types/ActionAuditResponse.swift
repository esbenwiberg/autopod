import Foundation

/// Response from GET /pods/:id/action-audit.
public struct ActionAuditResponse: Codable, Sendable {
  public let rows: [ActionAuditEntryResponse]
  public let chain: ActionAuditChainResponse
}

public struct ActionAuditEntryResponse: Codable, Identifiable, Sendable {
  public let id: Int
  public let podId: String
  public let actionName: String
  public let params: [String: AnyCodable]
  public let responseSummary: String?
  public let piiDetected: Bool
  public let quarantineScore: Double
  public let piiCategories: [String]?
  public let createdAt: String
  public let prevHash: String?
  public let entryHash: String?
}

public struct ActionAuditChainResponse: Codable, Sendable, Equatable {
  public let valid: Bool
  public let rowCount: Int
  public let firstBadId: Int?
  public let reason: String?
}
