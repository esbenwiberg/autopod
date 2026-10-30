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

  /// Cached diff responses keyed by pod ID.
  public private(set) var sessionDiffs: [String: DiffApiResponse] = [:]

  /// Persisted quality scores keyed by pod ID. Populated by
  /// `loadQualityScores()` alongside `loadSessions()`. Only terminal pods
  /// appear — running pods won't have a score until the recorder writes one.
  public private(set) var qualityScores: [String: PodQualityScore] = [:]

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
  struct Source: Hashable {
    let connectionID: UUID?
    let endpoint: URL
  }
  struct Ownership: Equatable {
    fileprivate let storeID: UUID
    fileprivate let epoch: UInt64
  }
  private let storeID = UUID()
  private var source: Source?
  var retainedSource: Source? { source }
  let decisionReplies = DecisionReplyStore()
  private var configurationEpoch: UInt64 = 0
  private var hydratedPodIds = Set<String>()
  private var hydratingPodIds = Set<String>()
  private var statusRevisions: [String: Int] = [:]
  // Tokens never repeat when a pod is removed and later reinserted.
  private var decisionSequence: UInt64 = 0
  private var decisionRevisions: [String: UInt64] = [:]
  private var fleetMembershipRevision = 0
  private var insertionRevisions: [String: Int] = [:]

  public func configure(api: DaemonAPI, connectionID: UUID? = nil) {
    let next = Source(connectionID: connectionID, endpoint: api.baseURL)
    if source != next {
      pods.removeAll()
      selectedSessionId = nil
      sessionDiffs.removeAll()
      qualityScores.removeAll()
      seriesCache.removeAll()
      statusRevisions.removeAll()
      decisionRevisions.removeAll()
      insertionRevisions.removeAll()
    }
    source = next
    configurationEpoch += 1
    self.api = api
    resetRequestState()
  }

  /// Keep readable last-observed data, but revoke all request/action authority.
  public func disconnect() {
    configurationEpoch += 1
    api = nil
    resetRequestState()
  }

  func ownership(for api: DaemonAPI) -> Ownership? {
    guard self.api === api else { return nil }
    return Ownership(storeID: storeID, epoch: configurationEpoch)
  }

  func isCurrent(_ ownership: Ownership?) -> Bool {
    guard let ownership, api != nil else { return false }
    return ownership.storeID == storeID && ownership.epoch == configurationEpoch
  }

  private func resetRequestState() {
    hydratedPodIds.removeAll()
    hydratingPodIds.removeAll()
    isLoading = false
    error = nil
  }

  private func recordInsertion(_ podId: String) {
    fleetMembershipRevision += 1
    insertionRevisions[podId] = fleetMembershipRevision
  }

  private func forgetPodState(_ podId: String) {
    decisionReplies.forget(source: source, podID: podId)
    hydratedPodIds.remove(podId)
    hydratingPodIds.remove(podId)
    statusRevisions.removeValue(forKey: podId)
    decisionRevisions.removeValue(forKey: podId)
    insertionRevisions.removeValue(forKey: podId)
  }

  private func shouldPreserveValidationProgress(
    _ progress: ValidationProgress?,
    for pod: Pod
  ) -> Bool {
    guard let progress else { return false }
    if pod.status == .validating { return true }
    if progress.hasRunningPhase { return true }
    return progress.advisoryDetail != nil && pod.validationChecks?.advisoryQa == nil
  }

  private func mergeRestPod(
    _ incoming: Pod,
    with current: Pod?,
    preferIncomingOnEqual: Bool,
    preserveCurrentStatus: Bool = false,
    preserveCurrentDecision: Bool = false
  ) -> Pod {
    guard let current else { return incoming }
    if !preferIncomingOnEqual
      && (current.updatedAt > incoming.updatedAt || current.updatedAt == incoming.updatedAt) {
      if current.updatedAt == incoming.updatedAt, current.fleetDisplay == nil,
         incoming.fleetDisplay != nil {
        var enriched = current
        enriched.fleetDisplay = incoming.fleetDisplay
        enriched.phase = incoming.phase
        return enriched
      }
      return current
    }
    var merged = incoming
    merged.fleetDisplay = incoming.fleetDisplay ?? current.fleetDisplay
    if preserveCurrentDecision || current.updatedAt > incoming.updatedAt {
      copyDecision(from: current, to: &merged)
    }
    if preserveCurrentStatus {
      merged.status = current.status
    } else if current.updatedAt > incoming.updatedAt {
      // Full hydration may race a newer WebSocket status. Keep the detail payload,
      // but never regress the lifecycle state or its freshness marker.
      merged.status = current.status
      merged.updatedAt = current.updatedAt
    }
    if shouldPreserveValidationProgress(current.validationProgress, for: merged) {
      var preserved = current.validationProgress
      if let incomingReview = incoming.validationProgress?.reviewProgress,
         (preserved?.reviewProgress?.updatedAt ?? .distantPast) < incomingReview.updatedAt {
        preserved?.reviewProgress = incomingReview
        preserved?.markStarted(.review)
      }
      merged.validationProgress = preserved
    }
    return merged
  }

  private func mergeCompactPod(
    _ incoming: Pod,
    with hydrated: Pod,
    preserveCurrentStatus: Bool,
    preserveCurrentDecision: Bool
  ) -> Pod {
    guard incoming.updatedAt > hydrated.updatedAt else {
      if incoming.updatedAt == hydrated.updatedAt, hydrated.fleetDisplay == nil,
         incoming.fleetDisplay != nil {
        var enriched = hydrated
        enriched.fleetDisplay = incoming.fleetDisplay
        enriched.phase = incoming.phase
        return enriched
      }
      return hydrated
    }
    var merged = hydrated
    if !preserveCurrentStatus {
      merged.status = incoming.status
    }
    if incoming.fleetDisplay != nil {
      merged.fleetDisplay = incoming.fleetDisplay
      merged.phase = incoming.phase
    }
    merged.completionPolicy = incoming.completionPolicy
    merged.pod = incoming.pod
    merged.hasWorktree = incoming.hasWorktree
    merged.branch = incoming.branch
    merged.profileName = incoming.profileName
    merged.model = incoming.model
    merged.startedAt = incoming.startedAt
    merged.updatedAt = incoming.updatedAt
    merged.baseBranch = incoming.baseBranch
    copyDecision(from: preserveCurrentDecision ? hydrated : incoming, to: &merged)
    merged.containerUrl = incoming.containerUrl
    merged.hasWebUi = incoming.hasWebUi
    merged.latestActivity = incoming.latestActivity
    merged.errorSummary = incoming.errorSummary
    merged.briefTitle = incoming.briefTitle
    merged.seriesId = incoming.seriesId
    merged.seriesName = incoming.seriesName
    merged.runningAt = incoming.runningAt
    merged.inputTokens = incoming.inputTokens
    merged.outputTokens = incoming.outputTokens
    merged.costUsd = incoming.costUsd
    merged.tokenTelemetryAccuracy = incoming.tokenTelemetryAccuracy
    merged.diffStats = incoming.diffStats
    return merged
  }

  // MARK: - Load

  public func loadSessions() async {
    guard let api else {
      error = "API client not configured — try disconnecting and reconnecting"
      return
    }
    let epoch = configurationEpoch
    isLoading = true
    error = nil
    let statusRevisionSnapshot = statusRevisions
    let decisionRevisionSnapshot = decisionRevisions
    let fleetMembershipSnapshot = fleetMembershipRevision
    do {
      let responses = try await api.listAllCompactPods()
      guard epoch == configurationEpoch else { return }
      let fresh = PodMapper.map(responses, baseURL: api.baseURL)
      let currentById = Dictionary(uniqueKeysWithValues: pods.map { ($0.id, $0) })
      let staleHydratedIds: Set<String> = Set(
        fresh.compactMap { pod -> String? in
          guard hydratedPodIds.contains(pod.id),
                let current = currentById[pod.id],
                pod.updatedAt > current.updatedAt else { return nil }
          return pod.id
        }
      )
      hydratedPodIds.subtract(staleHydratedIds)
      let discoveredIds = Set(fresh.map(\.id))
      let retained = pods.filter {
        !discoveredIds.contains($0.id)
          && insertionRevisions[$0.id, default: 0] > fleetMembershipSnapshot
      }
      let retainedIds = Set(retained.map(\.id))
      let removedIds = Set(currentById.keys)
        .subtracting(discoveredIds)
        .subtracting(retainedIds)
      let merged = fresh.map { pod in
        if hydratedPodIds.contains(pod.id), let current = currentById[pod.id] {
          return mergeCompactPod(
            pod,
            with: current,
            preserveCurrentStatus:
              statusRevisions[pod.id, default: 0]
                > statusRevisionSnapshot[pod.id, default: 0],
            preserveCurrentDecision: decisionRevisions[pod.id, default: 0]
              != decisionRevisionSnapshot[pod.id, default: 0]
          )
        }
        return mergeRestPod(
          pod,
          with: currentById[pod.id],
          preferIncomingOnEqual: false,
          preserveCurrentStatus:
            statusRevisions[pod.id, default: 0]
              > statusRevisionSnapshot[pod.id, default: 0],
          preserveCurrentDecision: decisionRevisions[pod.id, default: 0]
            != decisionRevisionSnapshot[pod.id, default: 0]
        )
      }
      // Pods created over WebSocket after page one sit outside the keyset snapshot.
      // Keep them visible until a later discovery traversal includes them.
      pods = retained + merged
      for id in discoveredIds { insertionRevisions.removeValue(forKey: id) }
      for id in removedIds { forgetPodState(id) }
      if let selectedSessionId, removedIds.contains(selectedSessionId) {
        self.selectedSessionId = nil
      }
      if let selectedSessionId, staleHydratedIds.contains(selectedSessionId) {
        await hydrateSessionIfNeeded(selectedSessionId)
      }
    } catch {
      guard epoch == configurationEpoch else { return }
      print("[PodStore] Failed to load pods: \(error)")
      self.error = error.localizedDescription
    }
    // Selected-pod hydration above can suspend across another configuration.
    guard epoch == configurationEpoch else { return }
    isLoading = false

    // Best-effort score refresh — failures are non-fatal. Fires after pods
    // so the UI paints the card list immediately and badges fill in next tick.
    await loadQualityScores()
  }

  /// Fetch the persisted quality scores and build the by-pod dictionary.
  /// Silent failure — the badge is a nice-to-have, not a blocker.
  public func loadQualityScores() async {
    guard let api else { return }
    let epoch = configurationEpoch
    do {
      let list = try await api.listQualityScores(limit: 500)
      guard epoch == configurationEpoch else { return }
      var byId: [String: PodQualityScore] = [:]
      byId.reserveCapacity(list.count)
      for score in list { byId[score.podId] = score }
      qualityScores = byId
    } catch {
      // Ignore — keep whatever we had. A disconnected daemon shouldn't clear
      // already-visible badges.
    }
  }

  public func refreshSession(_ id: String) async {
    _ = try? await readSession(id)
  }

  struct SessionRead {
    let returned: Pod
    let current: Pod
  }

  /// The same revision-aware refresh, with a real result for admission/preparation.
  /// The optional guard lets a caller retire its own work before this merge.
  func readSession(_ id: String, accepting: @MainActor () -> Bool = { true }) async throws -> SessionRead {
    guard let api else { throw URLError(.notConnectedToInternet) }
    let epoch = configurationEpoch
    let statusRevision = statusRevisions[id, default: 0]
    let decisionRevision = decisionRevisions[id, default: 0]
    let response = try await api.getPod(id)
    guard epoch == configurationEpoch, accepting() else { throw CancellationError() }
    let returned = PodMapper.map(response, baseURL: api.baseURL)
    var updated = returned
    if let index = pods.firstIndex(where: { $0.id == id }) {
      updated = mergeRestPod(
        updated,
        with: pods[index],
        preferIncomingOnEqual: true,
        preserveCurrentStatus: statusRevisions[id, default: 0] > statusRevision,
        preserveCurrentDecision: decisionRevisions[id, default: 0] != decisionRevision
      )
      if updated.validationProgress == nil && updated.status == .validating {
        updated.validationProgress = ValidationProgress.initial(attempt: updated.attempts?.current ?? 1)
      }
      pods[index] = updated
    } else {
      recordInsertion(id)
      pods.append(updated)
    }
    hydratedPodIds.insert(id)
    return SessionRead(returned: returned, current: updated)
  }

  public func hydrateSessionIfNeeded(_ id: String) async {
    guard !hydratedPodIds.contains(id), !hydratingPodIds.contains(id) else { return }
    let epoch = configurationEpoch
    hydratingPodIds.insert(id)
    defer {
      if epoch == configurationEpoch { hydratingPodIds.remove(id) }
    }
    await refreshSession(id)
  }

  // MARK: - Series

  /// Fetch and cache the full series response (metadata + cost roll-up). Pod
  /// statuses are already live in `pods` via the WebSocket stream, so callers
  /// should read pods from `pods.filter { $0.seriesId == id }` rather than
  /// from the cached response.
  @discardableResult
  public func loadSeries(_ seriesId: String) async -> SeriesResponse? {
    guard let api else { return nil }
    let epoch = configurationEpoch
    do {
      let response = try await api.getSeries(seriesId)
      guard epoch == configurationEpoch else { return nil }
      seriesCache[seriesId] = response
      // Upsert any pods in the response that aren't yet in our local store.
      for pod in PodMapper.map(response.pods) {
        if !pods.contains(where: { $0.id == pod.id }) {
          recordInsertion(pod.id)
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
    let epoch = configurationEpoch
    do {
      let response = try await api.getSessionDiff(podId)
      guard epoch == configurationEpoch else { return }
      let hasDiff =
        !response.files.isEmpty ||
        !(response.previewFiles ?? []).isEmpty ||
        !(response.uncommittedFiles ?? []).isEmpty ||
        !(response.commits ?? []).isEmpty
      // Only cache non-empty diff payloads — empty results should be retried on next event.
      if hasDiff {
        sessionDiffs[podId] = response
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
    statusRevisions[podId, default: 0] += 1
  }

  public func upsertSession(_ pod: Pod) {
    if let index = pods.firstIndex(where: { $0.id == pod.id }) {
      pods[index] = pod
    } else {
      recordInsertion(pod.id)
      pods.insert(pod, at: 0)
    }
  }

  public func removeSession(_ id: String) {
    pods.removeAll { $0.id == id }
    forgetPodState(id)
    if selectedSessionId == id {
      selectedSessionId = nil
    }
  }

  public func removeSeriesPods(_ seriesId: String) {
    let removedIds = pods.filter { $0.seriesId == seriesId }.map(\.id)
    pods.removeAll { $0.seriesId == seriesId }
    for id in removedIds { forgetPodState(id) }
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

  private func copyDecision(from source: Pod, to destination: inout Pod) {
    destination.escalationId = source.escalationId
    destination.escalationQuestion = source.escalationQuestion
    destination.escalationOptions = source.escalationOptions
    destination.escalationType = source.escalationType
  }

  public func setEscalation(
    _ podId: String, question: String?, options: [String]? = nil,
    id: String? = nil, type: String? = nil
  ) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    decisionSequence += 1
    decisionRevisions[podId] = decisionSequence
    pods[index].escalationId = id.flatMap { $0.isEmpty ? nil : $0 }
    pods[index].escalationQuestion = question
    pods[index].escalationOptions = options
    pods[index].escalationType = type
  }

  public func resolveEscalation(_ podId: String, id: String) {
    guard !id.isEmpty,
          let pod = pods.first(where: { $0.id == podId }), pod.escalationId == id else { return }
    setEscalation(podId, question: nil)
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
    if pods[index].validationProgress == nil {
      let attempt = pods[index].attempts?.current ?? 1
      pods[index].validationProgress = ValidationProgress.initial(attempt: attempt)
    }
    pods[index].validationProgress?.markStarted(phase)
  }

  public func markValidationPhaseCompleted(_ podId: String, phase: ValidationPhase, result: ValidationPhaseResult) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    if pods[index].validationProgress == nil {
      let attempt = pods[index].attempts?.current ?? 1
      pods[index].validationProgress = ValidationProgress.initial(attempt: attempt)
    }
    let baseURL = api?.baseURL
    pods[index].validationProgress?.markCompleted(phase, result: result) { dto in
      PodMapper.mapScreenshotRef(dto, baseURL: baseURL)
    }
  }

  public func applyReviewProgress(_ podId: String, progress: LiveReviewProgress) {
    guard let index = pods.firstIndex(where: { $0.id == podId }) else { return }
    if pods[index].validationProgress == nil {
      pods[index].validationProgress = ValidationProgress.initial(attempt: progress.attempt)
    }
    if let current = pods[index].validationProgress?.reviewProgress,
       current.updatedAt > progress.updatedAt {
      return
    }
    pods[index].validationProgress?.reviewProgress = progress
    pods[index].validationProgress?.markStarted(.review)
    pods[index].latestActivity = progress.summary()
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
    pods[index].tokenTelemetryAccuracy = .complete
  }


}
