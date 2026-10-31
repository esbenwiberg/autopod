import AutopodClient
import Foundation

/// Renderer-independent wire contract. Dates are Unix milliseconds, never Swift's reference date.
/// Full snapshots replace state; replay choreography, coordinates and sprite names do not belong here.
public struct VillageSnapshot: Codable, Equatable, Sendable {
    public static let version = 1
    public var schemaVersion = Self.version
    public let connected: Bool
    public let activityStreamConnected: Bool
    public let managedDataFresh: Bool
    public let reducedMotion: Bool
    public let selectedActorId: String?
    public let actors: [VillageActor]

    public func actor(id: String) -> VillageActor? { actors.first { $0.id == id } }
}

public struct VillageActor: Codable, Equatable, Identifiable, Sendable {
    public enum Source: String, Codable, Sendable { case native, managed }
    public enum DetailLevel: String, Codable, Sendable { case activity, lifecycle }
    public let id: String
    public let podId: String
    public let source: Source
    public let detailLevel: DetailLevel
    public let title: String
    public let profile: String
    public let model: String
    /// Original daemon state is authoritative even when activity suggests a different outcome.
    public let status: String
    public let stage: VillageStage
    public let statusUpdatedAt: Double
    public let interactive: Bool
    public let activity: VillageActivity?

    /// Managed runtime exit is separate from review/source-delivery state.
    /// Optional for compatibility with existing v1 renderer snapshots.
    public var observedExit: Bool? = nil

    public var isFinished: Bool {
        if ["complete", "killed"].contains(status) { return true }
        // Validation and handoff may still be active after the worker exits.
        return source == .managed && observedExit == true
            && !["validating", "handoff"].contains(status)
    }
}

public enum VillageStage: String, Codable, Sendable {
    case waiting, provisioning, working, validating, review, attention
    case releasing, complete, failed, stopping, stopped, unknown

    public init(status: String) {
        switch status {
        case "queued", "paused": self = .waiting
        case "provisioning": self = .provisioning
        case "running": self = .working
        case "validating": self = .validating
        case "validated", "review_required": self = .review
        case "awaiting_input", "research_ready": self = .attention
        case "approved", "merging", "merge_pending", "handoff": self = .releasing
        case "complete": self = .complete
        case "failed": self = .failed
        case "killing": self = .stopping
        case "killed": self = .stopped
        default: self = .unknown
        }
    }
}

/// A recent observation, not a claim that a tool is still running or that a check passed.
public struct VillageActivity: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case read, search, edit, command, check, review, plan, external, tool
    }
    public let kind: Kind
    public let label: String
    public let eventId: Int
    public let observedAt: Double
    public let isRecent: Bool
}

public enum VillageScene {
    public static func native(_ pod: Pod, events: [AgentEvent], now: Date) -> VillageActor {
        // Only the newest visible event may provide an activity. A later completion/result
        // clears the previous action. Never expose raw reasoning or tool output to the web view.
        let latest = events.filter { $0.type != .reasoning }.max {
            if $0.timestamp == $1.timestamp { return $0.id < $1.id }
            return $0.timestamp < $1.timestamp
        }
        let activity = pod.status == .running && !pod.isWorkspace
            ? latest.flatMap { observation($0, now: now) } : nil
        return VillageActor(
            id: "native:\(pod.id)", podId: pod.id, source: .native, detailLevel: .activity,
            title: bounded(pod.briefTitle ?? pod.task, fallback: pod.id),
            profile: bounded(pod.profileName), model: bounded(pod.model),
            status: pod.status.rawValue, stage: VillageStage(status: pod.status.rawValue),
            statusUpdatedAt: pod.updatedAt.timeIntervalSince1970 * 1_000,
            interactive: pod.isWorkspace, activity: activity
        )
    }

    public static func managed(_ pod: ManagedPodSummary) -> VillageActor {
        VillageActor(
            id: "managed:\(pod.id)", podId: pod.id, source: .managed, detailLevel: .lifecycle,
            title: managedPodDisplayName(pod.id), profile: bounded(pod.profileId),
            model: bounded(pod.model), status: pod.state, stage: VillageStage(status: pod.state),
            statusUpdatedAt: Double(pod.lastEventAt) * 1_000,
            interactive: false, activity: nil, observedExit: pod.observedExit
        )
    }

    private static func bounded(_ value: String, fallback: String = "") -> String {
        let line = value.split(whereSeparator: \.isNewline).first.map(String.init) ?? fallback
        return String(line.prefix(160))
    }

    private static func observation(_ event: AgentEvent, now: Date) -> VillageActivity? {
        let kind: VillageActivity.Kind
        let label: String
        switch event.type {
        case .fileChange: (kind, label) = (.edit, "File changed")
        case .plan: (kind, label) = (.plan, "Plan updated")
        case .toolUse:
            // Classify tool names only; prose and shell output cannot manufacture success.
            let tool = event.toolName?.lowercased().components(separatedBy: "__").last ?? ""
            switch tool {
            case "read", "read_file", "memory_read": (kind, label) = (.read, "Reading")
            case "grep", "glob", "search", "search_code", "memory_search":
                (kind, label) = (.search, "Searching")
            case "edit", "write", "multiedit", "apply_patch": (kind, label) = (.edit, "Editing")
            case "bash", "shell", "exec_command", "execute":
                (kind, label) = (.command, "Command activity")
            case "validate_locally", "validate_in_browser": (kind, label) = (.check, "Checking")
            case "pre_submit_review": (kind, label) = (.review, "Reviewing")
            case "webfetch", "websearch", "fetch": (kind, label) = (.external, "External request")
            case "tool_result": return nil
            default: (kind, label) = (.tool, "Tool activity")
            }
        default: return nil
        }
        let age = now.timeIntervalSince(event.timestamp)
        return VillageActivity(
            kind: kind, label: label, eventId: event.id,
            observedAt: event.timestamp.timeIntervalSince1970 * 1_000,
            isRecent: age >= 0 && age <= 30
        )
    }
}
