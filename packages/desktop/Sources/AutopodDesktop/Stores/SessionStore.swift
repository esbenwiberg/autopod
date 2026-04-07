import Foundation
import AutopodClient
import AutopodUI

/// Manages session state — loading from REST, updating from events.
@Observable
@MainActor
public final class SessionStore {

  // MARK: - Published state

  public private(set) var sessions: [Session] = []
  public var selectedSessionId: String?
  public private(set) var isLoading = false
  public private(set) var error: String?

  /// Cached diff strings keyed by session ID
  public private(set) var sessionDiffs: [String: String] = [:]

  public init() {}

  // MARK: - Computed groupings

  public var selectedSession: Session? {
    sessions.first { $0.id == selectedSessionId }
  }

  public var attentionSessions: [Session] {
    sessions.filter { $0.status.needsAttention }
  }

  public var runningSessions: [Session] {
    sessions.filter { $0.status.isActive && !$0.isWorkspace }
  }

  public var workspaceSessions: [Session] {
    sessions.filter { $0.isWorkspace }
  }

  public var completedSessions: [Session] {
    sessions.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }
  }

  // MARK: - API

  private var api: DaemonAPI?

  public func configure(api: DaemonAPI) {
    self.api = api
  }

  // MARK: - Load

  public func loadSessions() async {
    guard let api else { return }
    isLoading = true
    error = nil
    do {
      let responses = try await api.listSessions()
      sessions = SessionMapper.map(responses)
    } catch {
      print("[SessionStore] Failed to load sessions: \(error)")
      self.error = error.localizedDescription
    }
    isLoading = false
  }

  public func refreshSession(_ id: String) async {
    guard let api else { return }
    do {
      let response = try await api.getSession(id)
      let updated = SessionMapper.map(response)
      if let index = sessions.firstIndex(where: { $0.id == id }) {
        sessions[index] = updated
      }
    } catch {
      // Silent refresh failure — don't overwrite existing data
    }
  }

  // MARK: - Diff

  public func loadDiff(_ sessionId: String) async {
    guard let api else { return }
    do {
      let response = try await api.getSessionDiff(sessionId)
      // Reconstruct the raw diff string from structured files
      let raw = response.files.map(\.diff).joined(separator: "\n")
      // Only cache non-empty diffs — empty results should be retried on next event
      if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        sessionDiffs[sessionId] = raw
      } else {
        sessionDiffs.removeValue(forKey: sessionId)
      }
    } catch {
      // Diff not available — that's fine, it'll show empty state
    }
  }

  // MARK: - Mutation (called by EventStream or ActionHandler)

  public func updateStatus(_ sessionId: String, to status: SessionStatus) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].status = status
  }

  public func upsertSession(_ session: Session) {
    if let index = sessions.firstIndex(where: { $0.id == session.id }) {
      sessions[index] = session
    } else {
      sessions.insert(session, at: 0)
    }
  }

  public func removeSession(_ id: String) {
    sessions.removeAll { $0.id == id }
    if selectedSessionId == id {
      selectedSessionId = nil
    }
  }

  public func updateActivity(_ sessionId: String, activity: String) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].latestActivity = activity
  }

  public func updateDiffStats(_ sessionId: String, added: Int, removed: Int, files: Int) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].diffStats = DiffStats(added: added, removed: removed, files: files)
  }

  public func updatePlan(_ sessionId: String, plan: SessionPlan) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].plan = plan
  }

  public func updatePhase(_ sessionId: String, phase: PhaseProgress) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].phase = phase
  }

  public func setEscalation(_ sessionId: String, question: String?, options: [String]? = nil) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].escalationQuestion = question
    sessions[index].escalationOptions = options
  }

  public func setValidationChecks(_ sessionId: String, checks: ValidationChecks) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].validationChecks = checks
  }

  public func setPrUrl(_ sessionId: String, url: URL) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].prUrl = url
  }

  public func setError(_ sessionId: String, summary: String) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].errorSummary = summary
  }

  public func updateTokens(_ sessionId: String, input: Int, output: Int, cost: Double) {
    guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
    sessions[index].inputTokens = input
    sessions[index].outputTokens = output
    sessions[index].costUsd = cost
  }
}
