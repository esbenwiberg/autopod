import Foundation
import AutopodClient
import AutopodUI

/// Bridges the WebSocket event stream into PodStore updates.
/// Owns the EventSocket lifecycle and dispatches events.
@Observable
@MainActor
public final class EventStream {

  // MARK: - Types

  public enum HistoricalLoadState: Equatable {
    case idle, loading, loaded, failed(String)
  }

  // MARK: - State

  public private(set) var connectionState: String = "Disconnected"
  public private(set) var recentEvents: [AgentEvent] = []

  /// Per-pod event buffers (keyed by pod ID)
  public private(set) var sessionEvents: [String: [AgentEvent]] = [:]

  /// Load state for the historical REST fetch (keyed by pod ID)
  public private(set) var historicalLoadState: [String: HistoricalLoadState] = [:]

  private var eventSocket: EventSocket?
  private let podStore: PodStore
  private weak var memoryStore: MemoryStore?
  private weak var scheduledJobStore: ScheduledJobStore?
  private var eventIdCounter = 0

  private static let globalEventCap = 500
  private static let sessionEventCap = 1000

  // Throttle: batch event mutations to avoid flooding SwiftUI's AttributeGraph
  private var pendingGlobalEvents: [AgentEvent] = []
  private var pendingSessionEvents: [(String, AgentEvent)] = []
  private var flushTask: Task<Void, Never>?

  // MARK: - Init

  public init(
    podStore: PodStore,
    memoryStore: MemoryStore? = nil,
    scheduledJobStore: ScheduledJobStore? = nil
  ) {
    self.podStore = podStore
    self.memoryStore = memoryStore
    self.scheduledJobStore = scheduledJobStore
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
    flushTask?.cancel()
    flushTask = nil
    flushPendingEvents()
    connectionState = "Disconnected"
  }

  /// Subscribe to a specific pod's events (when detail panel opens)
  public func subscribeToSession(_ podId: String) {
    Task {
      await eventSocket?.subscribe(podId: podId)
    }
  }

  /// Unsubscribe from a pod (when navigating away)
  public func unsubscribeFromSession(_ podId: String) {
    Task {
      await eventSocket?.unsubscribe(podId: podId)
    }
  }

  /// Load historical agent events for a pod from the daemon REST API.
  /// Always refetches; reconciles by preserving any live (positive-ID) events
  /// already in the buffer so a stale partial WS buffer doesn't suppress the backfill.
  public func loadHistoricalEvents(podId: String, api: DaemonAPI) {
    historicalLoadState[podId] = .loading
    Task {
      do {
        let events = try await api.getSessionEvents(podId)
        let mapped = events.enumerated().map { (i, e) in
          // Use negative IDs so they never collide with the live eventIdCounter (which starts at 1)
          mapAgentEvent(e, id: -(events.count - i))
        }
        let liveEvents = (sessionEvents[podId] ?? []).filter { $0.id > 0 }
        sessionEvents[podId] = mapped + liveEvents
        historicalLoadState[podId] = .loaded
      } catch {
        historicalLoadState[podId] = .failed(error.localizedDescription)
      }
    }
  }

  // MARK: - Event dispatch

  private func handleRawEvent(_ raw: RawSystemEvent) {
    guard let event = SystemEvent.parse(raw) else { return }

    switch event {
    case .sessionCreated(let summary):
      // Refresh from REST to get full pod data
      Task { await podStore.refreshSession(summary.id) }
      // If refresh fails, at least show the pod exists
      // (refreshSession handles the upsert)

    case .statusChanged(let podId, _, let newStatus):
      if let status = PodStatus(rawValue: newStatus) {
        podStore.updateStatus(podId, to: status)
      }
      // Full refresh to pick up any other changed fields
      Task { await podStore.refreshSession(podId) }
      // Reload diff when entering states that imply code changes exist
      let diffStates: Set<String> = ["validating", "validated", "approved", "merging", "complete"]
      if diffStates.contains(newStatus) {
        Task { await podStore.loadDiff(podId) }
      }

    case .agentActivity(let podId, let agentEvent):
      handleAgentActivity(podId: podId, event: agentEvent)

    case .validationStarted(let podId, let attempt):
      podStore.updateStatus(podId, to: .validating)
      podStore.initValidationProgress(podId, attempt: attempt)

    case .validationPhaseStarted(let podId, let phase):
      podStore.markValidationPhaseStarted(podId, phase: phase)

    case .validationPhaseCompleted(let podId, let phase, let result):
      podStore.markValidationPhaseCompleted(podId, phase: phase, result: result)

    case .validationCompleted(let podId, let result):
      let passed = result.overall == "pass"
      let checks = ValidationChecks(
        smoke: result.smoke.status == "pass",
        tests: PodMapper.mapTriState(result.test?.status),
        lint: PodMapper.mapTriState(result.lint?.status),
        sast: PodMapper.mapTriState(result.sast?.status),
        review: PodMapper.mapTriState(result.taskReview?.status),
        reviewSkipReason: result.reviewSkipReason
      )
      podStore.setValidationChecks(podId, checks: checks)
      // Notification
      if let pod = podStore.pods.first(where: { $0.id == podId }) {
        NotificationService.shared.notifyValidationComplete(pod: pod, passed: passed)
      }
      // Full refresh for status change + reload diff (now available post-validation)
      Task { await podStore.refreshSession(podId) }
      Task { await podStore.loadDiff(podId) }

    case .escalationCreated(let podId, let escalation):
      let question = escalation.payload.question ?? escalation.payload.description ?? "Input needed"
      let options: [String]? = {
        guard let opts = escalation.payload.options, !opts.isEmpty else { return nil }
        return opts
      }()
      podStore.setEscalation(podId, question: question, options: options)
      podStore.updateStatus(podId, to: .awaitingInput)
      // Notification
      if let pod = podStore.pods.first(where: { $0.id == podId }) {
        NotificationService.shared.notifyEscalation(pod: pod, question: question)
      }

    case .escalationResolved(let podId, _):
      podStore.setEscalation(podId, question: nil)
      podStore.updateStatus(podId, to: .running)

    case .sessionCompleted(let podId, let finalStatus, _):
      if let status = PodStatus(rawValue: finalStatus) {
        podStore.updateStatus(podId, to: status)
      }
      // Notification
      if let pod = podStore.pods.first(where: { $0.id == podId }) {
        if finalStatus == "complete" {
          NotificationService.shared.notifySessionComplete(pod: pod)
        }
      }
      // Full refresh for final state
      Task { await podStore.refreshSession(podId) }

    case .memorySuggestionCreated(_, let entry):
      memoryStore?.handleSuggestionCreated(entry)

    case .validationOverrideQueued(let podId, _):
      // Refresh pod so pending overrides count updates in the UI
      Task { await podStore.refreshSession(podId) }

    case .scheduledJobCatchupRequested(let jobId, let jobName, let lastRunAt):
      scheduledJobStore?.markCatchupPending(jobId)
      NotificationService.shared.notifyMissedJob(jobId: jobId, jobName: jobName, lastRunAt: lastRunAt)

    case .scheduledJobFired(let jobId, _, let podId):
      Task { await scheduledJobStore?.refreshJob(jobId) }
      Task { await podStore.refreshSession(podId) }
    }
  }

  private func handleAgentActivity(podId: String, event: AgentEventResponse) {
    // Build UI-level AgentEvent
    eventIdCounter += 1
    let uiEvent = mapAgentEvent(event, id: eventIdCounter)

    // Buffer events for throttled flush (avoids per-event @Observable mutations)
    pendingGlobalEvents.append(uiEvent)
    pendingSessionEvents.append((podId, uiEvent))
    scheduleFlush()

    // Update card activity with human-readable summary for overview-worthy events only
    if uiEvent.type.isOverviewWorthy {
      podStore.updateActivity(podId, activity: uiEvent.summary)
    }

    // Update pod fields based on event type
    switch event.type {
    case "plan":
      if let summary = event.summary {
        podStore.updatePlan(
          podId,
          plan: SessionPlan(summary: summary, steps: event.steps ?? [])
        )
      }

    case "progress":
      if let current = event.currentPhase, let total = event.totalPhases,
         let desc = event.description {
        podStore.updatePhase(
          podId,
          phase: PhaseProgress(current: current, total: total, description: desc)
        )
      }

    case "error":
      if let msg = event.message {
        podStore.setError(podId, summary: msg)
      }

    case "task_summary":
      if let actualSummary = event.actualSummary {
        let deviations = (event.deviations ?? []).map {
          DeviationItem(step: $0.step, planned: $0.planned, actual: $0.actual, reason: $0.reason)
        }
        podStore.updateTaskSummary(
          podId,
          summary: TaskSummary(actualSummary: actualSummary, deviations: deviations)
        )
      }

    case "complete":
      if let input = event.totalInputTokens, let output = event.totalOutputTokens,
         let cost = event.costUsd {
        podStore.updateTokens(podId, input: input, output: output, cost: cost)
      }

    default:
      break
    }
  }

  // MARK: - Throttled flush

  private func scheduleFlush() {
    guard flushTask == nil else { return }
    flushTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(100))
      self?.flushPendingEvents()
      self?.flushTask = nil
    }
  }

  private func flushPendingEvents() {
    guard !pendingGlobalEvents.isEmpty else { return }

    // Batch-apply global events
    recentEvents.append(contentsOf: pendingGlobalEvents)
    if recentEvents.count > Self.globalEventCap {
      recentEvents.removeFirst(recentEvents.count - Self.globalEventCap)
    }

    // Batch-apply per-pod events
    for (podId, event) in pendingSessionEvents {
      var buffer = sessionEvents[podId, default: []]
      buffer.append(event)
      if buffer.count > Self.sessionEventCap {
        buffer.removeFirst(buffer.count - Self.sessionEventCap)
      }
      sessionEvents[podId] = buffer
    }

    pendingGlobalEvents.removeAll()
    pendingSessionEvents.removeAll()
  }

  private func mapAgentEvent(_ response: AgentEventResponse, id: Int) -> AgentEvent {
    var type = AgentEventType(rawValue: response.type) ?? .output
    // tool_result events arrive as {type: "tool_use", tool: "tool_result"} from the stream parser
    if type == .toolUse && response.tool == "tool_result" {
      type = .toolResult
    }
    let date = PodMapper.parseDate(response.timestamp)

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
      detail: EventStream.detailForEvent(response),
      toolName: response.tool,
      isFatal: response.fatal ?? false
    )
  }

  /// Resolve the expanded-detail string for a log row.
  ///
  /// Priority: tool/file output, then file diff, then structured payload —
  /// `escalation` events render their full `EscalationPayload`, and `tool_use`
  /// events (including MCP escalation + dynamic action tools) render their
  /// input payload so the agent's question/params are revealed on click.
  /// `tool_result` events keep the output-first path and never fall through
  /// to input rendering.
  private static func detailForEvent(_ response: AgentEventResponse) -> String? {
    if let output = response.output, !output.isEmpty { return output }
    if let diff = response.diff, !diff.isEmpty { return diff }
    if response.type == "escalation" {
      return escalationDetail(payload: response.payload)
    }
    if response.type == "tool_use", response.tool != "tool_result" {
      return toolInputDetail(response.input)
    }
    return nil
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
      // Built-in tools above have custom formatting. For everything else —
      // MCP escalation tools (ask_ai, ask_human, report_*, memory_*,
      // validate_in_browser, request_credential, trigger_revalidation) and
      // dynamic action tools registered from the profile's action policy —
      // pick the most useful single field to display inline.
      return genericInputSummary(input)
    }
  }

  /// Extract a one-line inline summary from an unknown tool's input payload.
  /// Tries a priority list of common field names, then falls back to the first
  /// non-empty top-level string value. Nil when nothing usable is present.
  private static func genericInputSummary(_ input: AnyCodable) -> String? {
    let priorityKeys = [
      "question", "description", "summary", "plan", "message",
      "url", "query", "command", "file_path", "path", "name",
      "actionName", "key",
    ]
    let pathKeys: Set<String> = ["file_path", "path"]

    for key in priorityKeys {
      if let value = input[key]?.stringValue, !value.isEmpty {
        return pathKeys.contains(key) ? shortenPath(value) : value
      }
    }
    if let dict = input.asDict {
      for (_, v) in dict.sorted(by: { $0.key < $1.key }) {
        if let s = v.stringValue, !s.isEmpty { return s }
      }
    }
    return nil
  }

  /// Render a tool's full input payload as multi-line key/value text for the
  /// expanded detail bubble. Returns nil for trivial payloads where the inline
  /// summary already shows everything (single short single-line string field).
  private static func toolInputDetail(_ input: AnyCodable?) -> String? {
    guard let input, let dict = input.asDict, !dict.isEmpty else { return nil }
    if dict.count == 1, let only = dict.values.first,
       let s = only.stringValue, !s.contains("\n"), s.count <= 80 {
      return nil
    }
    return prettyPayload(input, indent: 0)
  }

  /// Render an EscalationPayload's non-nil fields as multi-line key/value text.
  private static func escalationDetail(payload: EscalationPayload?) -> String? {
    guard let payload else { return nil }
    var lines: [String] = []

    func appendString(_ key: String, _ value: String?) {
      guard let value, !value.isEmpty else { return }
      if value.contains("\n") {
        lines.append("\(key):")
        for line in value.components(separatedBy: "\n") {
          lines.append("  \(line)")
        }
      } else {
        lines.append("\(key): \(value)")
      }
    }

    func appendList(_ key: String, _ items: [String]?) {
      guard let items, !items.isEmpty else { return }
      lines.append("\(key):")
      for item in items { lines.append("  - \(item)") }
    }

    appendString("question", payload.question)
    appendString("context", payload.context)
    appendString("domain", payload.domain)
    appendList("options", payload.options)
    appendString("description", payload.description)
    appendList("attempted", payload.attempted)
    appendString("needs", payload.needs)
    appendString("actionName", payload.actionName)
    if let params = payload.params, !params.isEmpty {
      lines.append("params:")
      for (k, v) in params.sorted(by: { $0.key < $1.key }) {
        if let s = v.stringValue, !s.contains("\n") {
          lines.append("  \(k): \(s)")
        } else {
          lines.append("  \(k): \(v.displayValue)")
        }
      }
    }

    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }

  /// Pretty-print an AnyCodable payload as YAML-ish indented text.
  /// String values with newlines are preserved on their own indented lines;
  /// nested dicts/arrays recurse one indent level deeper.
  private static func prettyPayload(_ value: AnyCodable, indent: Int) -> String {
    let pad = String(repeating: "  ", count: indent)
    if let dict = value.asDict {
      return dict.sorted(by: { $0.key < $1.key }).map { key, val in
        if let s = val.stringValue {
          if s.contains("\n") {
            let block = s.components(separatedBy: "\n")
              .map { "\(pad)  \($0)" }
              .joined(separator: "\n")
            return "\(pad)\(key):\n\(block)"
          }
          return "\(pad)\(key): \(s)"
        }
        if val.asDict != nil || val.asArray != nil {
          return "\(pad)\(key):\n\(prettyPayload(val, indent: indent + 1))"
        }
        return "\(pad)\(key): \(val.displayValue)"
      }.joined(separator: "\n")
    }
    if let arr = value.asArray {
      return arr.map { v in
        if v.asDict != nil {
          return "\(pad)-\n\(prettyPayload(v, indent: indent + 1))"
        }
        return "\(pad)- \(v.displayValue)"
      }.joined(separator: "\n")
    }
    return "\(pad)\(value.displayValue)"
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
