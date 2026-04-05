import SwiftUI

// MARK: - Event types (aligned with packages/shared/src/types/runtime.ts)

public enum AgentEventType: String, Sendable {
    case status                    // AgentStatusEvent — state transitions
    case toolUse = "tool_use"      // AgentToolUseEvent — tool calls (Read, Edit, Bash, etc.)
    case toolResult = "tool_result" // tool_result acks — filtered out in UI (noise)
    case fileChange = "file_change" // AgentFileChangeEvent — file created/modified/deleted
    case escalation   // AgentEscalationEvent — ask_human / ask_ai / report_blocker
    case plan         // AgentPlanEvent — plan summary with steps
    case progress     // AgentProgressEvent — phase progress tracking
    case error        // AgentErrorEvent — errors with fatal flag
    case complete     // AgentCompleteEvent — task completion with token/cost info
    case output       // Agent text output / reasoning

    public var label: String {
        switch self {
        case .status:     "Status"
        case .toolUse:    "Tool"
        case .toolResult: "Result"
        case .fileChange: "File"
        case .escalation: "Escalation"
        case .plan:       "Plan"
        case .progress:   "Phase"
        case .error:      "Error"
        case .complete:   "Done"
        case .output:     "Output"
        }
    }

    public var icon: String {
        switch self {
        case .status:     "arrow.right.circle"
        case .toolUse:    "wrench"
        case .toolResult: "wrench"
        case .fileChange: "doc.badge.plus"
        case .escalation: "bubble.left.and.exclamationmark.bubble.right"
        case .plan:       "list.bullet.clipboard"
        case .progress:   "flag"
        case .error:      "exclamationmark.triangle"
        case .complete:   "checkmark.circle"
        case .output:     "text.quote"
        }
    }

    public var color: Color {
        switch self {
        case .status:     .blue
        case .toolUse:    .blue
        case .toolResult: .secondary
        case .fileChange: .blue
        case .escalation: .orange
        case .plan:       .secondary
        case .progress:   .secondary
        case .error:      .red
        case .complete:   .secondary
        case .output:     .secondary
        }
    }

    /// Events that are noise and should be filtered from the default log view
    public var isNoise: Bool {
        self == .toolResult
    }
}

// MARK: - Event

public struct AgentEvent: Identifiable, Sendable {
    public let id: Int
    public let timestamp: Date
    public let type: AgentEventType
    public let summary: String
    public let detail: String?
    /// For tool_use: the tool name (bash, read, edit, etc.)
    public let toolName: String?
    /// For error: is this fatal?
    public let isFatal: Bool

    public init(
        id: Int, timestamp: Date, type: AgentEventType, summary: String,
        detail: String? = nil, toolName: String? = nil, isFatal: Bool = false
    ) {
        self.id = id; self.timestamp = timestamp; self.type = type
        self.summary = summary; self.detail = detail
        self.toolName = toolName; self.isFatal = isFatal
    }

    public var timeString: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: timestamp)
    }
}

// MARK: - Plan (mirrors AgentPlanEvent)

public struct AgentPlan: Sendable {
    public let summary: String
    public let steps: [String]
    public init(summary: String, steps: [String]) {
        self.summary = summary; self.steps = steps
    }
}
