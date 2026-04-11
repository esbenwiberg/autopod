import Foundation

// MARK: - Memory (mirrors packages/shared/src/types/memory.ts)

public enum MemoryScope: String, CaseIterable, Sendable, Codable {
    case global, profile, session

    public var label: String {
        switch self {
        case .global:  "Global"
        case .profile: "Profile"
        case .session: "Session"
        }
    }
}

public struct MemoryEntry: Identifiable, Sendable, Codable {
    public let id: String
    public let scope: MemoryScope
    public let scopeId: String?
    public let path: String
    public let content: String
    public let contentSha256: String
    public let version: Int
    public let approved: Bool
    public let createdBySessionId: String?
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String, scope: MemoryScope, scopeId: String? = nil,
        path: String, content: String, contentSha256: String = "",
        version: Int = 1, approved: Bool = false,
        createdBySessionId: String? = nil,
        createdAt: String = "", updatedAt: String = ""
    ) {
        self.id = id; self.scope = scope; self.scopeId = scopeId
        self.path = path; self.content = content; self.contentSha256 = contentSha256
        self.version = version; self.approved = approved
        self.createdBySessionId = createdBySessionId
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}
