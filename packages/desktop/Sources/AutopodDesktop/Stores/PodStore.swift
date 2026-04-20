import Foundation
import AutopodClient
import AutopodUI

/// Manages pod state — loading from REST, updating from events.
@Observable
@MainActor
public final class PodStore {

  // MARK: - Published state

  public private(set) var pods: [Pod] = []
  public var selectedSessionId: String?
  public private(set) var isLoading = false
  public private(set) var error: String?

  /// Cached diff strings keyed by pod ID
  public private(set) var sessionDiffs: [String: String] = [:]

  /// Cached series responses keyed by series ID. Populated via `loadSeries`;
  /// individual pod updates stream in through the normal event bus and the
  /// pipeline view filters `pods` by seriesId at render time, so this cache
  /// is only authoritative for series-level metadata (tokenUsageSummary, etc.).
  public private(set) var seriesCache: [String: SeriesResponse] = [:]

  public init() {}

  // MARK: - Computed groupings

  public var selectedSession: Pod? {
    pods.first { $0.id == selectedSessionId }
  }

  public var attentionSessions: [Pod] {
    pods.filter { $0.status.needsAttention }
  }

  public var runningSessions: [Pod] {
    pods.filter { $0.status.isActive && !$0.isWorkspace }
  }

  public var workspaceSessions: [Pod] {
    pods.filter { $0.isWorkspace }
  }

  public var completedSessions: [Pod] {
    pods.filter { [.complete, .killed].contains($0.status) && !$0.isWorkspace }
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
      let responses = try await api.listPods()
      pods = PodMapper.map(responses)
    } catch {
      print("[PodStore] Failed to load pods: \(error)")
      self.error = error.localizedDescription
    }
    isLoading = false
  }

  public func refreshSession(_ id: String) async {
    guard let api else { return }
    do {
      let response = try await api.getPod(id)
      var updated = PodMapper.map(response)
      if let index = pods.firstIndex(where: { $0.id == id }) {
        // Preserve live WebSocket state that REST doesn't carry
        updated.validationProgress = pods[index].validationProgress
        pods[index] = updated
      } else {
        pods.append(updated)
      }
    } catch {
      // Silent refresh failure — don't overwrite existing data
    }
  }

  // MARK: - Series

  /// Fetch and cache the full series response (metadata + cost roll-up). Pod
  /// statuses are already live in `pods` via the WebSocket stream, so callers
  /// should read pods from `pods.filter { $0.seriesId == id }` rather than
  /// from the cached response.
  @discardableResult
  public func loadSeries(_ seriesId: String) async -> SeriesResponse? {
    guard let api else { return nil }
    do {
      let response = try await api.getSeries(seriesId)
      seriesCache[seriesId] = response
      // Upsert any pods in the response that aren't yet in our local store.
      for pod in PodMapper.map(response.pods) {
        if !pods.contains(where: { $0.id == pod.id }) {
          pods.append(pod)
        }
      }
      return response
    } catch {
      return nil
    }
  }

  // MARK: - Diff

  public func loadDiff(_ podId: String) async {
    guard let api else { return }
    do {
      let response = try await api.getSessionDiff(podId)
      // Reconstruct the raw diff string from structured files
      let raw = response.files.map(\.diff).joined(separator: "\n")
      // Only cache non-empty diffs — empty results should be retried on next event
      if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        sessionDiffs[podId] = raw
      } else {
        sessionDiffs.removeValue(forKey: podId)
      }
    } catch {
      // Diff not available — that's fine, it'll show empty state
    }
  }

  // MARK: - Mutation (called by EventStream or ActionHandler)

  public func updateStatus(_ podId: String, to status: PodStatus) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].status = status
  }

  public func upsertSession(_ pod: Pod) {
    if let index = pods.firstIndex(where: { $0.id == pod.id }) {
      pods[index] = pod
    } else {
      pods.insert(pod, at: 0)
    }
  }

  public func removeSession(_ id: String) {
    pods.removeAll { $0.id == id }
    if selectedSessionId == id {
      selectedSessionId = nil
    }
  }

  public func removeSeriesPods(_ seriesId: String) {
    let removedIds = pods.filter { $0.seriesId == seriesId }.map(\.id)
    pods.removeAll { $0.seriesId == seriesId }
    if let selected = selectedSessionId, removedIds.contains(selected) {
      selectedSessionId = nil
    }
  }

  public func updateActivity(_ podId: String, activity: String) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].latestActivity = activity
  }

  public func updateDiffStats(_ podId: String, added: Int, removed: Int, files: Int) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].diffStats = DiffStats(added: added, removed: removed, files: files)
  }

  public func updatePlan(_ podId: String, plan: SessionPlan) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].plan = plan
  }

  public func updatePhase(_ podId: String, phase: PhaseProgress) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].phase = phase
  }

  public func setEscalation(_ podId: String, question: String?, options: [String]? = nil) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].escalationQuestion = question
    pods[index].escalationOptions = options
  }

  public func setValidationChecks(_ podId: String, checks: ValidationChecks) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].validationChecks = checks
  }

  public func initValidationProgress(_ podId: String, attempt: Int) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].validationProgress = ValidationProgress.initial(attempt: attempt)
  }

  public func markValidationPhaseStarted(_ podId: String, phase: ValidationPhase) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].validationProgress?.markStarted(phase)
  }

  public func markValidationPhaseCompleted(_ podId: String, phase: ValidationPhase, result: ValidationPhaseResult) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].validationProgress?.markCompleted(phase, result: result)
  }

  public func setPrUrl(_ podId: String, url: URL) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].prUrl = url
  }

  public func setError(_ podId: String, summary: String) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].errorSummary = summary
  }

  public func updateTaskSummary(_ podId: String, summary: TaskSummary) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].taskSummary = summary
  }

  public func updateTokens(_ podId: String, input: Int, output: Int, cost: Double) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    pods[index].inputTokens = input
    pods[index].outputTokens = output
    pods[index].costUsd = cost
  }

  // MARK: - History workspace

  public func createHistoryWorkspace(profileName: String?, limit: Int) async {
    guard let api else { return }
    do {
      let response = try await api.createHistoryWorkspace(
        profileName: profileName,
        limit: limit
      )
      let pod = PodMapper.map(response)
      upsertSession(pod)
      selectedSessionId = pod.id
    } catch {
      print("[PodStore] Failed to create history workspace: \(error)")
      self.error = error.localizedDescription
    }
  }
}
