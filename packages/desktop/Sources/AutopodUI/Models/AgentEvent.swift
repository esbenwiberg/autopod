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
    case taskSummary = "task_summary" // AgentTaskSummaryEvent — final task summary with deviations
    case reasoning    // AgentReasoningEvent — agent reasoning / thinking

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
        case .complete:    "Done"
        case .taskSummary: "Summary"
        case .reasoning:   "Reasoning"
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
        case .complete:    "checkmark.circle"
        case .taskSummary: "doc.text.below.ecg"
        case .reasoning:   "text.quote"
        }
    }

    public var color: Color {
        switch self {
        case .status:     .cyan
        case .toolUse:    .purple
        case .toolResult: .secondary
        case .fileChange: .green
        case .escalation: .orange
        case .plan:       .blue
        case .progress:   .teal
        case .error:      .red
        case .complete:    .green
        case .taskSummary: .indigo
        case .reasoning:   .secondary
        }
    }

    /// Events that are noise and should be filtered from the default log view
    public var isNoise: Bool {
        self == .toolResult
    }

    /// High-level events worth showing in the overview activity feed
    public var isOverviewWorthy: Bool {
        switch self {
        case .status, .fileChange, .escalation, .plan, .progress, .error, .complete, .taskSummary:
            return true
        case .toolUse, .toolResult, .reasoning:
            return false
        }
    }
}

// MARK: - Event

public struct AgentEvent: Identifiable, Sendable {
    private static let plainMCPToolNames: Set<String> = [
        "ask_human", "ask_ai", "report_blocker", "report_plan", "report_progress",
        "report_task_summary", "check_messages", "request_credential",
        "validate_in_browser", "validate_locally", "pre_submit_review",
        "memory_list", "memory_read", "memory_search", "memory_suggest",
        "trigger_revalidation",
        "activate_pim_group", "deactivate_pim_group", "list_pim_activations",
        "activate_pim_role", "deactivate_pim_role",
        "run_deploy_script",
        "query_logs", "read_app_insights", "read_container_logs",
        "read_issue", "search_issues", "read_issue_comments",
        "read_pr", "read_pr_comments", "read_pr_diff",
        "read_file", "search_code",
        "ado_read_pr", "ado_read_pr_threads", "ado_read_pr_changes",
        "ado_read_file", "ado_search_code",
        "read_workitem", "search_workitems",
        "ado_run_test_pipeline", "ado_get_test_run_status",
    ]

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

    public var isMCPToolCall: Bool {
        guard type == .toolUse, let toolName else { return false }
        return toolName.hasPrefix("mcp__") || Self.plainMCPToolNames.contains(toolName)
    }

    public var displayIcon: String {
        isMCPToolCall ? "point.3.connected.trianglepath.dotted" : type.icon
    }

    public var displayColor: Color {
        isMCPToolCall ? .teal : type.color
    }
}
