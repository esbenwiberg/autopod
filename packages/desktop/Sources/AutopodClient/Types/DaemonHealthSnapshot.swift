import Foundation

public struct DaemonHealthSnapshot: Codable, Sendable {
    public let status: String
    public let version: String?
    public let release: DaemonReleaseSnapshot?
    public let backup: DaemonBackupSnapshot?

    public var releaseSummary: String {
        guard let sha = release?.commitSha else { return "Release identity unavailable" }
        return sha + (release?.dirty == true ? " · modified source" : "")
    }
    public var backupSummary: String {
        "Backup: \(backup?.state ?? "unavailable") · \(backup?.lastCompletedAt ?? "freshness unverified")"
    }
}
public struct DaemonReleaseSnapshot: Codable, Sendable {
    public let commitSha: String?
    public let dirty: Bool?
    public let builtAt: String?
    public let source: String?
}
public struct DaemonBackupSnapshot: Codable, Sendable {
    public let state: String
    public let lastCompletedAt: String?
    public let ageMs: Double?
    public let snapshotIntegrity: String?
}
