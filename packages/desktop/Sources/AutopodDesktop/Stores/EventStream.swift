import Foundation
import AutopodClient
import AutopodUI

/// Bridges the WebSocket event stream into SessionStore updates.
/// Owns the EventSocket lifecycle and dispatches events.
@Observable
@MainActor
public final class EventStream {

  // MARK: - State

  public private(set) var connectionState: String = "Disconnected"
  public private(set) var recentEvents: [AgentEvent] = []

  /// Per-session event buffers (keyed by session ID)
  public private(set) var sessionEvents: [String: [AgentEvent]] = [:]

  private var eventSocket: EventSocket?
  private let sessionStore: SessionStore
  private var eventIdCounter = 0

  private static let globalEventCap = 500
  private static let sessionEventCap = 1000

  // MARK: - Init

  public init(sessionStore: SessionStore) {
    self.sessionStore = sessionStore
  }

  // MARK: - Lifecycle

  public func connect(baseURL: URL, token: String) {
    disconnect()

    let socket = EventSocket(
      baseURL: baseURL,
      token: token,
      onEvent: { [weak self] raw in
        Task { @MainActor [weak self] in
          self?.handleRawEvent(raw)
        }
      },
      onStateChange: { [weak self] state in
        Task { @MainActor [weak self] in
          self?.handleStateChange(state)
        }
      }
    )
    eventSocket = socket

    Task {
      await socket.connect()
    }
  }

  public func disconnect() {
    Task {
      await eventSocket?.disconnect()
    }
    eventSocket = nil
    connectionState = "Disconnected"
  }

  /// Subscribe to a specific session's events (when detail panel opens)
  public func subscribeToSession(_ sessionId: String) {
    Task {
      await eventSocket?.subscribe(sessionId: sessionId)
    }
  }

  /// Unsubscribe from a session (when navigating away)
  public func unsubscribeFromSession(_ sessionId: String) {
    Task {
      await eventSocket?.unsubscribe(sessionId: sessionId)
    }
  }

  /// Load historical agent events for a session from the daemon REST API.
  /// No-ops if events are already present (avoids duplication on reconnect).
  public func loadHistoricalEvents(sessionId: String, api: DaemonAPI) {
    guard sessionEvents[sessionId] == nil || sessionEvents[sessionId]!.isEmpty else { return }
    Task {
      guard let events = try? await api.getSessionEvents(sessionId), !events.isEmpty else { return }
      let mapped = events.enumerated().map { (i, e) in
        // Use negative IDs so they never collide with the live eventIdCounter (which starts at 1)
        mapAgentEvent(e, id: -(events.count - i))
      }
      // Only set if still empty — a live event may have raced us
      if sessionEvents[sessionId]?.isEmpty ?? true {
        sessionEvents[sessionId] = mapped
      }
    }
  }

  // MARK: - Event dispatch

  private func handleRawEvent(_ raw: RawSystemEvent) {
    guard let event = SystemEvent.parse(raw) else { return }

    switch event {
    case .sessionCreated(let summary):
      // Refresh from REST to get full session data
      Task { await sessionStore.refreshSession(summary.id) }
      // If refresh fails, at least show the session exists
      // (refreshSession handles the upsert)

    case .statusChanged(let sessionId, _, let newStatus):
      if let status = SessionStatus(rawValue: newStatus) {
        sessionStore.updateStatus(sessionId, to: status)
      }
      // Full refresh to pick up any other changed fields
      Task { await sessionStore.refreshSession(sessionId) }
      // Reload diff when entering states that imply code changes exist
      let diffStates: Set<String> = ["validating", "validated", "approved", "merging", "complete"]
      if diffStates.contains(newStatus) {
        Task { await sessionStore.loadDiff(sessionId) }
      }

    case .agentActivity(let sessionId, let agentEvent):
      handleAgentActivity(sessionId: sessionId, event: agentEvent)

    case .validationStarted(let sessionId, _):
      sessionStore.updateStatus(sessionId, to: .validating)

    case .validationCompleted(let sessionId, let result):
      let passed = result.overall == "pass"
      let checks = ValidationChecks(
        smoke: result.smoke.status == "pass",
        tests: SessionMapper.mapTriState(result.test?.status),
        review: SessionMapper.mapTriState(result.taskReview?.status),
        reviewSkipReason: result.reviewSkipReason
      )
      sessionStore.setValidationChecks(sessionId, checks: checks)
      // Notification
      if let session = sessionStore.sessions.first(where: { $0.id == sessionId }) {
        NotificationService.shared.notifyValidationComplete(session: session, passed: passed)
      }
      // Full refresh for status change + reload diff (now available post-validation)
      Task { await sessionStore.refreshSession(sessionId) }
      Task { await sessionStore.loadDiff(sessionId) }

    case .escalationCreated(let sessionId, let escalation):
      let question = escalation.payload.question ?? escalation.payload.description ?? "Input needed"
      let options: [String]? = {
        guard let opts = escalation.payload.options, !opts.isEmpty else { return nil }
        return opts
      }()
      sessionStore.setEscalation(sessionId, question: question, options: options)
      sessionStore.updateStatus(sessionId, to: .awaitingInput)
      // Notification
      if let session = sessionStore.sessions.first(where: { $0.id == sessionId }) {
        NotificationService.shared.notifyEscalation(session: session, question: question)
      }

    case .escalationResolved(let sessionId, _):
      sessionStore.setEscalation(sessionId, question: nil)
      sessionStore.updateStatus(sessionId, to: .running)

    case .sessionCompleted(let sessionId, let finalStatus, _):
      if let status = SessionStatus(rawValue: finalStatus) {
        sessionStore.updateStatus(sessionId, to: status)
      }
      // Notification
      if let session = sessionStore.sessions.first(where: { $0.id == sessionId }) {
        if finalStatus == "complete" {
          NotificationService.shared.notifySessionComplete(session: session)
        }
      }
      // Full refresh for final state
      Task { await sessionStore.refreshSession(sessionId) }
    }
  }

  private func handleAgentActivity(sessionId: String, event: AgentEventResponse) {
    // Build UI-level AgentEvent
    eventIdCounter += 1
    let uiEvent = mapAgentEvent(event, id: eventIdCounter)

    // Add to global recent events
    recentEvents.append(uiEvent)
    if recentEvents.count > Self.globalEventCap {
      recentEvents.removeFirst(recentEvents.count - Self.globalEventCap)
    }

    // Add to per-session buffer
    var buffer = sessionEvents[sessionId, default: []]
    buffer.append(uiEvent)
    if buffer.count > Self.sessionEventCap {
      buffer.removeFirst(buffer.count - Self.sessionEventCap)
    }
    sessionEvents[sessionId] = buffer

    // Update session fields based on event type
    switch event.type {
    case "status":
      if let msg = event.message {
        sessionStore.updateActivity(sessionId, activity: msg)
      }

    case "tool_use":
      if let tool = event.tool {
        let summary = event.path.map { "\(tool): \($0)" } ?? tool
        sessionStore.updateActivity(sessionId, activity: summary)
      }

    case "file_change":
      if let path = event.path, let action = event.action {
        sessionStore.updateActivity(sessionId, activity: "\(action) \(path)")
      }

    case "plan":
      if let summary = event.summary {
        sessionStore.updatePlan(
          sessionId,
          plan: SessionPlan(summary: summary, steps: event.steps ?? [])
        )
      }

    case "progress":
      if let current = event.currentPhase, let total = event.totalPhases,
         let desc = event.description {
        sessionStore.updatePhase(
          sessionId,
          phase: PhaseProgress(current: current, total: total, description: desc)
        )
      }

    case "error":
      if let msg = event.message {
        sessionStore.setError(sessionId, summary: msg)
      }

    case "task_summary":
      if let actualSummary = event.actualSummary {
        let deviations = (event.deviations ?? []).map {
          DeviationItem(step: $0.step, planned: $0.planned, actual: $0.actual, reason: $0.reason)
        }
        sessionStore.updateTaskSummary(
          sessionId,
          summary: TaskSummary(actualSummary: actualSummary, deviations: deviations)
        )
      }

    case "complete":
      if let input = event.totalInputTokens, let output = event.totalOutputTokens,
         let cost = event.costUsd {
        sessionStore.updateTokens(sessionId, input: input, output: output, cost: cost)
      }

    default:
      break
    }
  }

  private func mapAgentEvent(_ response: AgentEventResponse, id: Int) -> AgentEvent {
    var type = AgentEventType(rawValue: response.type) ?? .output
    // tool_result events arrive as {type: "tool_use", tool: "tool_result"} from the stream parser
    if type == .toolUse && response.tool == "tool_result" {
      type = .toolResult
    }
    let date = SessionMapper.parseDate(response.timestamp)

    let summary: String = {
      switch response.type {
      case "status": return response.message ?? "Status update"
      case "tool_use":
        guard let tool = response.tool else { return "Tool use" }
        let detail = EventStream.toolSummary(tool: tool, input: response.input)
        return detail.map { "\(tool) \($0)" } ?? tool
      case "file_change":
        let action = response.action ?? "changed"
        let path = response.path.map { EventStream.shortenPath($0) } ?? "file"
        return "\(action) \(path)"
      case "escalation": return response.payload?.question ?? "Escalation"
      case "plan": return response.summary ?? "Plan created"
      case "progress": return response.description ?? "Phase progress"
      case "task_summary": return response.actualSummary ?? "Task summary reported"
      case "error": return response.message ?? "Error"
      case "complete": return "Agent finished"
      default: return response.message ?? response.type
      }
    }()

    return AgentEvent(
      id: id,
      timestamp: date,
      type: type,
      summary: summary,
      detail: response.output ?? response.diff,
      toolName: response.tool,
      isFatal: response.fatal ?? false
    )
  }

  // MARK: - Summary helpers

  /// Extract a human-readable detail string from a tool's input parameters.
  private static func toolSummary(tool: String, input: AnyCodable?) -> String? {
    guard let input else { return nil }
    switch tool {
    case "Bash":
      return input["command"]?.stringValue
    case "Read":
      return input["file_path"]?.stringValue.map { shortenPath($0) }
    case "Edit", "MultiEdit":
      return input["file_path"]?.stringValue.map { shortenPath($0) }
    case "Write":
      return input["file_path"]?.stringValue.map { shortenPath($0) }
    case "Grep":
      let pattern = input["pattern"]?.stringValue
      let path = input["path"]?.stringValue.map { shortenPath($0) }
      if let pattern, let path { return "\"\(pattern)\" in \(path)" }
      return pattern.map { "\"\($0)\"" }
    case "Glob":
      return input["pattern"]?.stringValue
    case "ToolSearch":
      return input["query"]?.stringValue
    case "TodoWrite":
      return input["todos"]?.stringValue
    default:
      // For unknown tools, try common field names
      return input["command"]?.stringValue
        ?? input["file_path"]?.stringValue.map { shortenPath($0) }
        ?? input["query"]?.stringValue
    }
  }

  /// Strip /workspace/ prefix and leading ./ from container paths.
  private static func shortenPath(_ path: String) -> String {
    var p = path
    if p.hasPrefix("/workspace/") { p = String(p.dropFirst("/workspace/".count)) }
    if p.hasPrefix("./") { p = String(p.dropFirst(2)) }
    return p
  }

  /// Truncate to max characters, appending ellipsis if needed.
  private static func truncate(_ s: String, max: Int) -> String {
    s.count <= max ? s : String(s.prefix(max)) + "…"
  }

  // MARK: - State change

  private func handleStateChange(_ state: EventSocket.State) {
    switch state {
    case .disconnected: connectionState = "Disconnected"
    case .connecting: connectionState = "Connecting…"
    case .connected: connectionState = "Connected"
    case .reconnecting(let attempt): connectionState = "Reconnecting (\(attempt))…"
    }
  }
}
