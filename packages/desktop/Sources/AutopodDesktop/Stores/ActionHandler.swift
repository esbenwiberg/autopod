import Foundation
import AppKit
import AutopodClient
import AutopodUI

/// Executes pod actions against the daemon API. Approval waits for daemon
/// acceptance because readiness gates may reject the request.
@Observable
@MainActor
public final class ActionHandler {

  public private(set) var pendingAction: String?
  public private(set) var pendingApprovals: Set<String> = []
  private var bulkApprovalPending = false
  public private(set) var lastError: String?
  /// Error from the most recent preview call, or nil on success. Separate
  /// from lastError so the series sheet doesn't pick up unrelated failures.
  public private(set) var lastPreviewError: String?
  /// Error from the most recent create-pod call. Kept separate from lastError
  /// so creation sheets can show submit failures inline.
  public private(set) var lastCreatePodError: String?

  private struct OwnedControl {
    let id: UUID
    let kind: PendingPodControl
    let task: Task<Bool, Never>
  }
  @ObservationIgnored private var controls: [String: OwnedControl] = [:]
  @ObservationIgnored private var deletionWorkflows: [String: OwnedControl] = [:]
  private var pendingControls: [String: PendingPodControl] = [:]

  public func pendingControl(_ podId: String) -> PendingPodControl? {
    pendingControls[podId]
  }

  private let api: DaemonAPI
  private var pendingForkRequests: [String: ComposableLaunchRequest] = [:]
  private var pendingWorkerRequests: [String: (draft: Data, request: ComposableLaunchRequest)] = [:]
  private let podStore: PodStore
  private let profileStore: ProfileStore

  private let replyContextID = UUID()
  private let replySource: PodStore.Source?
  private let ownership: PodStore.Ownership?
  private let journalRoot: URL?

  public init(api: DaemonAPI, podStore: PodStore, profileStore: ProfileStore, journalRoot: URL? = nil) {
    self.api = api
    self.podStore = podStore
    self.profileStore = profileStore
    self.ownership = podStore.ownership(for: api)
    self.replySource = podStore.ownership(for: api) == nil ? nil : podStore.retainedSource
    self.journalRoot = journalRoot
  }

  private func requireCurrent() throws {
    guard podStore.isCurrent(ownership) else {
      throw DaemonError.networkError("Connection changed. Refresh before continuing.")
    }
  }

  /// Admission is local authority, not cancellation of already-admitted server work.
  private func perform<T>(_ operation: @MainActor () async throws -> T) async throws -> T {
    try requireCurrent()
    do {
      let result = try await operation()
      try requireCurrent()
      return result
    } catch {
      // A late 404/error belongs to the old owner too; do not normalize it as current.
      try requireCurrent()
      throw error
    }
  }

  /// Build a PodActions struct wired to this handler.
  public var actions: PodActions {
    var result = PodActions(
      approve: { [weak self] id, reason in await self?.approve(id, reason: reason) },
      reject: { [weak self] id, feedback in await self?.reject(id, feedback: feedback) },
      reply: { [weak self] id, message in await self?.reply(id, message: message) },
      decisionReply: decisionReplyActions,
      nudge: { [weak self] id, message in await self?.nudge(id, message: message) },
      pendingControl: { [weak self] id in self?.pendingControl(id) },
      killAndDelete: { [weak self] id in await self?.killAndDelete(id) },
      kill: { [weak self] id in await self?.kill(id) },
      complete: { [weak self] id in await self?.complete(id) },
      pause: { [weak self] id in await self?.pause(id) },
      rework: { [weak self] id in await self?.rework(id) },
      fixManually: { [weak self] id in await self?.fixManually(id) },
      revalidate: { [weak self] id in await self?.revalidate(id) },
      createPod: { [weak self] profile, task, model, pod, executionTarget, base, branchPrefix, pimGroups, sidecars, refRepos, brief in
        await self?.createPod(
          profileName: profile, task: task, model: model,
          pod: pod,
          executionTarget: executionTarget,
          baseBranch: base, branchPrefix: branchPrefix,
          pimGroups: pimGroups,
          requireSidecars: sidecars,
          referenceRepos: refRepos,
          briefMetadata: brief
        )
      },
      promote: { [weak self] id, target, instructions, skipAgent in
        await self?.promoteSession(
          id,
          targetOutput: target,
          instructions: instructions,
          skipAgent: skipAgent
        )
      },
      approveAll: { [weak self] in await self?.approveAllValidated() },
      killAllFailed: { [weak self] in await self?.killAllFailed() },
      extendAttempts: { [weak self] id, count in await self?.extendAttempts(id, additionalAttempts: count) },
      extendPrAttempts: { [weak self] id, count in await self?.extendPrAttempts(id, additionalAttempts: count) },
      fork: { [weak self] id in await self?.forkSession(id) },
      delete: { [weak self] id in await self?.deletePod(id) },
      deleteSeries: { [weak self] id in await self?.deleteSeries(id) },
      openLiveApp: { [weak self] id in await self?.openLiveApp(id) },
      interruptValidation: { [weak self] id in await self?.interruptValidation(id) },
      setSkipValidation: { [weak self] id, skip in await self?.setSkipValidation(id, skip: skip) },
      addValidationOverride: { [weak self] id, fid, desc, action, reason, guidance in
        await self?.addValidationOverride(id, findingId: fid, description: desc, action: action, reason: reason, guidance: guidance)
      },
      forceApprove: { [weak self] id, reason in await self?.forceApprove(id, reason: reason) },
      approveFactWaiver: { [weak self] id, factId, reason in
        await self?.approveFactWaiver(id, factId: factId, reason: reason)
      },
      spawnFix: { [weak self] id, message in await self?.spawnFixSession(id, userMessage: message) ?? nil },
      retryCreatePr: { [weak self] id in await self?.retryCreatePr(id) },
      retryDraftScope: api.baseURL.absoluteString,
      loadGoal: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        do { return try await self.perform { try await self.api.getGoal(id) } }
        catch DaemonError.notFound { return nil }
      },
      controlGoal: { [weak self] id, request in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.controlGoal(id, body: request) }
      },
      loadExecutionProvenance: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.getExecutionProvenance(id) }
      },
      loadDispatchPreflight: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.getDispatchPreflight(id) }
      },
      loadRerunTemplate: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.getRerunTemplate(id) }
      },
      createIntentionalRerun: { [weak self] request in
        guard let self else { throw URLError(.notConnectedToInternet) }
        let response = try await self.perform { try await self.api.createIntentionalRerun(request) }
        self.podStore.upsertSession(PodMapper.map(response))
        return response.id
      },
      loadRetryState: { [weak self] id, stage in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.getRetryState(id, stage: stage) }
      },
      authorizeRetry: { [weak self] id, input in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.perform { try await self.api.authorizeRetry(id, request: input) }
      },
      reworkRetry: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        try await self.perform { try await self.api.triggerValidation(id) }
        try await self.perform { await self.podStore.refreshSession(id) }
      },
      resumeRetry: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        _ = try await self.perform { try await self.api.resumePod(id) }
        try await self.perform { await self.podStore.refreshSession(id) }
      },
      resume: { [weak self] id in await self?.resume(id) },
      recoverWorktree: { [weak self] id in await self?.recoverWorktree(id) ?? nil },
      forceComplete: { [weak self] id, reason in await self?.forceComplete(id, reason: reason) },
      kick: { [weak self] id, reason in await self?.kick(id, reason: reason) },
      previewSeriesFolder: { [weak self] path in
        await self?.previewSeriesFolder(path: path) ?? nil
      },
      previewSeriesOnBranch: { [weak self] profile, branch, path in
        await self?.previewSeriesOnBranch(profileName: profile, branch: branch, path: path) ?? nil
      },
      previewBriefFolder: { [weak self] path in
        await self?.previewBriefFolder(path: path) ?? nil
      },
      previewBriefOnBranch: { [weak self] profile, branch, path in
        await self?.previewBriefOnBranch(sourcePodId: profile, branch: branch, path: path) ?? nil
      },
      lastPreviewError: { [weak self] in self?.lastPreviewError },
      lastCreatePodError: { [weak self] in self?.lastCreatePodError },
      createSeries: { [weak self] request in
        await self?.createSeries(request) ?? nil
      },
      launchWorker: { [weak self] podId, task, brief, sidecars in
        await self?.launchWorker(podId, task: task, brief: brief, sidecars: sidecars)
      },
      syncWorkspaceBranch: { [weak self] id in
        await self?.syncWorkspaceBranch(id) ?? nil
      },
      updateFromBase: { [weak self] id in
        await self?.updateFromBase(id) ?? nil
      }
    )
    result.repair = PodRepairActions(scope: replyContextID.uuidString, submit: { [weak self] id, kind, message in
      guard let self else { throw DaemonError.networkError("Connection is unavailable") }
      return try await self.submitRepair(id, kind: kind, message: message)
    }, inspect: { [weak self] id in
      guard let self else { throw DaemonError.networkError("Connection is unavailable") }
      let source = try await self.perform { try await self.api.getPod(id) }
      let pods = try await self.perform { try await self.api.listPods() }
      let mapped = pods.map { PodMapper.map($0) }
      self.podStore.upsertSession(PodMapper.map(source))
      for pod in mapped where pod.linkedSessionId == id || pod.id == source.fixPodId { self.podStore.upsertSession(pod) }
      return PodRepairObservation(source: PodMapper.map(source), related: mapped.filter {
        $0.linkedSessionId == id || $0.id == source.fixPodId || (source.seriesId != nil && $0.seriesId == source.seriesId)
      })
    })
    result.approvalPending = { [weak self] id in self?.pendingApprovals.contains(id) == true }
    return result
  }

  public func submitRepair(_ id: String, kind: PodRepairKind, message: String?) async throws -> PodRepairReceipt {
    pendingAction = "repair-\(kind.rawValue)-\(id)"
    defer { pendingAction = nil }
    switch kind {
    case .manual:
      let workspace = try await perform { try await api.fixManually(id) }
      podStore.upsertSession(PodMapper.map(workspace))
      return PodRepairReceipt(message: "Linked workspace admitted. Follow its observed state as it provisions.", podID: workspace.id)
    case .rework:
      try await perform { try await api.triggerValidation(id) }
      return PodRepairReceipt(message: "Request accepted. Waiting for the pod’s observed execution state.")
    case .revalidate:
      _ = try await perform { try await api.revalidateSession(id) }
      return PodRepairReceipt(message: "Validation request accepted. Follow the pod’s observed validation state.")
    case .resume:
      _ = try await perform { try await api.resumePod(id) }
      return PodRepairReceipt(message: "Recovery request accepted. Follow observed delivery and validation state.")
    case .prFix:
      let response = try await perform { try await api.spawnFixSession(id, userMessage: message) }
      guard response.ok else {
        throw DaemonError.badRequest(response.reason == "parent_terminal" ? "This parent is terminal and cannot accept fix feedback. Your message is retained." : "PR repair was rejected: \(response.reason ?? "no reason supplied"). Your message is retained.")
      }
      return PodRepairReceipt(message: "PR feedback accepted. The daemon may create or reuse a fix pod; later events identify it.", podID: response.fixPodId, unreadFeedback: response.queueLength)
    }
  }

  // MARK: - Actions

  public func approve(_ podId: String, reason: String? = nil) async {
    guard pendingApprovals.insert(podId).inserted else { return }
    let marker = "approve-\(podId)"
    pendingAction = marker
    defer {
      pendingApprovals.remove(podId)
      if pendingAction == marker { pendingAction = nil }
    }
    do {
      try await perform { try await api.approvePod(podId, reason: reason) }
      // Status is updated by the daemon event after readiness gates accept the approval.
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func reject(_ podId: String, feedback: String?) async {
    pendingAction = "reject-\(podId)"
    do {
      try await perform { try await api.rejectPod(podId, feedback: feedback) }
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func reply(_ podId: String, message: String) async {
    pendingAction = "reply-\(podId)"
    do {
      try await perform { try await api.sendMessage(podId, message: message) }
      // A reply may leave another decision pending or advance into validation.
      // Keep the observed state until the daemon confirms its actual disposition.
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func nudge(_ podId: String, message: String) async {
    pendingAction = "nudge-\(podId)"
    do {
      try await perform { try await api.nudgeSession(podId, message: message) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func kill(_ podId: String) async {
    _ = await controlTask(podId, kind: .kill)?.value
  }

  /// Admission is synchronous on MainActor. Caller cancellation does not cancel
  /// an unstructured task that other callers are also awaiting.
  private func controlTask(_ podId: String, kind: PendingPodControl) -> Task<Bool, Never>? {
    do { try requireCurrent() } catch { lastError = error.localizedDescription; return nil }
    if let workflow = deletionWorkflows[podId] {
      return kind == .kill ? workflow.task : nil
    }
    if let current = controls[podId] {
      return current.kind == kind ? current.task : nil
    }
    let id = UUID()
    let marker = "\(kind == .pause ? "pause" : "kill")-\(podId)"
    pendingAction = marker
    pendingControls[podId] = kind
    let task = Task { @MainActor in
      defer {
        if self.controls[podId]?.id == id {
          self.controls.removeValue(forKey: podId)
          if self.deletionWorkflows[podId] == nil {
            self.pendingControls.removeValue(forKey: podId)
          }
          if self.pendingAction == marker { self.pendingAction = nil }
        }
      }
      do {
        if kind == .pause { try await self.perform { try await self.api.pauseSession(podId) } }
        else { try await self.perform { try await self.api.killPod(podId) } }
        try await self.perform { await self.podStore.refreshSession(podId) }
        return true // POST acknowledgement only; refresh may fail or observe another state.
      } catch {
        self.lastError = error.localizedDescription
        return false
      }
    }
    controls[podId] = OwnedControl(id: id, kind: kind, task: task)
    return task
  }

  public func killAndDelete(_ podId: String) async {
    do { try requireCurrent() } catch { lastError = error.localizedDescription; return }
    if let current = deletionWorkflows[podId] {
      _ = await current.task.value
      return
    }
    // Admit/join Kill before publishing the combined workflow, avoiding self-join.
    guard let kill = controlTask(podId, kind: .kill) else { return }
    let id = UUID()
    let task = Task { @MainActor in
      defer {
        if self.deletionWorkflows[podId]?.id == id {
          self.deletionWorkflows.removeValue(forKey: podId)
          self.pendingControls.removeValue(forKey: podId)
        }
      }
      guard await kill.value else { return false }
      await self.deletePodRaw(podId)
      return true
    }
    deletionWorkflows[podId] = OwnedControl(id: id, kind: .killAndDelete, task: task)
    pendingControls[podId] = .killAndDelete
    _ = await task.value
  }

  public func complete(_ podId: String) async {
    pendingAction = "complete-\(podId)"
    do {
      try await perform { try await api.completeSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func pause(_ podId: String) async {
    _ = await controlTask(podId, kind: .pause)?.value
  }

  public func rework(_ podId: String) async {
    pendingAction = "rework-\(podId)"
    do {
      try await perform { try await api.triggerValidation(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func fixManually(_ podId: String) async -> String? {
    pendingAction = "fix-\(podId)"
    do {
      let workspace = try await perform { try await api.fixManually(podId) }
      let pod = PodMapper.map(workspace)
      podStore.upsertSession(pod)
      pendingAction = nil
      return workspace.id
    } catch {
      lastError = error.localizedDescription
      pendingAction = nil
      return nil
    }
  }

  public func revalidate(_ podId: String) async {
    pendingAction = "revalidate-\(podId)"
    do {
      _ = try await perform { try await api.revalidateSession(podId) }
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func extendAttempts(_ podId: String, additionalAttempts: Int) async {
    pendingAction = "extend-\(podId)"
    do {
      try await perform { try await api.extendAttempts(podId, additionalAttempts: additionalAttempts) }
      // Status will be updated via WebSocket event (back to running/validating)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func extendPrAttempts(_ podId: String, additionalAttempts: Int) async {
    pendingAction = "extend-pr-\(podId)"
    do {
      try await perform { try await api.extendPrAttempts(podId, additionalAttempts: additionalAttempts) }
      // Status will be updated via WebSocket event (back to merge_pending)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  @discardableResult
  public func spawnFixSession(_ podId: String, userMessage: String? = nil) async -> SpawnFixResponse? {
    pendingAction = "spawn-fix-\(podId)"
    defer { pendingAction = nil }
    do {
      let response = try await perform { try await api.spawnFixSession(podId, userMessage: userMessage) }
      // Fix pod will appear via WebSocket pod.created event
      return response
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func retryCreatePr(_ podId: String) async {
    pendingAction = "retry-pr-\(podId)"
    do {
      try await perform { try await api.retryCreatePr(podId) }
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func resume(_ podId: String) async {
    pendingAction = "resume-\(podId)"
    do {
      _ = try await perform { try await api.resumePod(podId) }
      // Resume can flip the pod back to validated (Path 1) or kick off a fresh
      // validation (Path 2). Either way the WebSocket will stream the eventual
      // status — but pull a fresh snapshot now so the UI doesn't sit on `failed`.
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func recoverWorktree(_ podId: String) async -> RecoverWorktreeResponse? {
    pendingAction = "recover-worktree-\(podId)"
    defer { pendingAction = nil }
    do {
      let result = try await perform { try await api.recoverWorktree(podId) }
      // The daemon clears `worktreeCompromised` on success, so refresh now to
      // re-enable Resume/Rework. On failure the flag stays set; the surfaced
      // message tells the operator what to do next.
      try await perform { await podStore.refreshSession(podId) }
      if !result.recovered {
        lastError = "Recovery failed: \(result.message)"
      }
      return result
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func forceComplete(_ podId: String, reason: String?) async {
    pendingAction = "force-complete-\(podId)"
    do {
      let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
      try await perform { try await api.forceComplete(podId, reason: (trimmed?.isEmpty ?? true) ? nil : trimmed) }
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func kick(_ podId: String, reason: String?) async {
    pendingAction = "kick-\(podId)"
    do {
      let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
      _ = try await perform { try await api.kickPod(podId, reason: (trimmed?.isEmpty ?? true) ? nil : trimmed) }
      // Kick may flip a queued pod back into the active queue (status unchanged)
      // or transition a running pod to failed. Either way refresh now so the
      // UI doesn't sit on the old state until the next WebSocket tick.
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func createPod(
    profileName: String, task: String, model: String?,
    pod: PodConfigRequest?,
    executionTarget: String? = nil,
    baseBranch: String?, branchPrefix: String? = nil,
    pimGroups: [PimGroupRequest]? = nil,
    requireSidecars: [String]? = nil,
    referenceRepos: [ReferenceRepoRequest]? = nil,
    briefMetadata: BriefPodMetadata? = nil
  ) async -> String? {
    pendingAction = "create"
    lastCreatePodError = nil
    let req = CreateSessionRequest(
      profileName: profileName,
      task: task,
      model: model?.isEmpty == true ? nil : model,
      executionTarget: executionTarget?.isEmpty == true ? nil : executionTarget,
      contract: briefMetadata?.contract,
      briefTitle: briefMetadata?.briefTitle,
      touches: briefMetadata?.touches,
      doesNotTouch: briefMetadata?.doesNotTouch,
      pod: pod,
      startBranch: briefMetadata?.startBranch?.isEmpty == true ? nil : briefMetadata?.startBranch,
      baseBranch: baseBranch?.isEmpty == true ? nil : baseBranch,
      specFiles: briefMetadata?.specFiles?.isEmpty == true ? nil : briefMetadata?.specFiles,
      branchPrefix: branchPrefix?.isEmpty == true ? nil : branchPrefix,
      pimGroups: pimGroups?.filter { !$0.groupId.isEmpty },
      requireSidecars: (requireSidecars?.isEmpty ?? true) ? nil : requireSidecars,
      referenceRepos: (referenceRepos?.isEmpty ?? true) ? nil : referenceRepos
    )
    do {
      let response = try await perform { try await api.createPod(req) }
      let pod = PodMapper.map(response)
      podStore.upsertSession(pod)
      lastCreatePodError = nil
      pendingAction = nil
      return response.id
    } catch {
      lastCreatePodError = error.localizedDescription
      pendingAction = nil
      return nil
    }
  }

  public func promoteSession(
    _ podId: String,
    targetOutput: String?,
    instructions: String? = nil,
    skipAgent: Bool = false
  ) async {
    pendingAction = "promote-\(podId)"
    do {
      try await perform { try await api.promoteSession(
        podId,
        targetOutput: targetOutput,
        instructions: instructions,
        skipAgent: skipAgent
      ) }
      // Status will be updated via WebSocket event (running → handoff → provisioning → ...)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func approveAllValidated() async {
    guard !bulkApprovalPending else { return }
    bulkApprovalPending = true
    // Own only new markers so bulk completion cannot clear an individual request.
    let owned = Set(podStore.pods.filter {
      $0.status == .validated && !pendingApprovals.contains($0.id)
    }.map(\.id))
    pendingApprovals.formUnion(owned)
    pendingAction = "approve-all"
    defer {
      bulkApprovalPending = false
      pendingApprovals.subtract(owned)
      if pendingAction == "approve-all" { pendingAction = nil }
    }
    do {
      _ = try await perform { try await api.approveAllValidated() }
      try await perform { await podStore.loadSessions() }
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func killAllFailed() async {
    pendingAction = "kill-failed"
    do {
      _ = try await perform { try await api.killAllFailed() }
      try await perform { await podStore.loadSessions() }
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func forkSession(_ podId: String) async -> String? {
    pendingAction = "fork-\(podId)"
    defer { pendingAction = nil }
    do {
      try requireCurrent()
      var request: ComposableLaunchRequest
      if let pending = pendingForkRequests[podId] { request = pending }
      else {
        guard let source = podStore.pods.first(where: { $0.id == podId }) else {
          throw DaemonError.networkError("Source pod is unavailable")
        }
        let frozen = try await perform { try await api.getLaunchConfiguration(podId) }
        request = ComposableLaunchRequest(
          repositoryId: frozen.fields["repository"]?["id"]?.string,
          profileId: frozen.fields["profileId"]?.string, task: source.task)
        request.repositorySetupId = frozen.fields["repository"]?["setup"]?["id"]?.string
        if request.repositoryId == nil { request.emptyWorkspace = true }
        request.source = LaunchSource(podId: podId, digest: frozen.digest, configuration: "original")
        if request.repositoryId != nil {
          request.work = ["startBranch": .string(source.branch)]
          if let base = source.baseBranch { request.work?["baseBranch"] = .string(base) }
        }
        request.requestId = UUID().uuidString
        request.expectedDigest = try await perform { try await api.resolveLaunch(request) }.digest
        pendingForkRequests[podId] = request
      }
      try requireCurrent()
      _ = try LaunchRequestJournal.save(request, directory: journalRoot?.appendingPathComponent("launches", isDirectory: true))
      let response = try await perform { try await api.launchPod(request) }
      podStore.upsertSession(PodMapper.map(response))
      pendingForkRequests.removeValue(forKey: podId)
      lastError = nil
      return response.id
    } catch { lastError = error.localizedDescription; return nil }
  }

  public func deletePod(_ podId: String) async {
    do { try requireCurrent() } catch { lastError = error.localizedDescription; return }
    if let workflow = deletionWorkflows[podId] {
      _ = await workflow.task.value
      return
    }
    await deletePodRaw(podId)
  }

  private func deletePodRaw(_ podId: String) async {
    pendingAction = "delete-\(podId)"
    do {
      try await perform { try await api.deletePod(podId) }
      podStore.removeSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    if pendingAction == "delete-\(podId)" { pendingAction = nil }
  }

  public func deleteSeries(_ seriesId: String) async {
    pendingAction = "delete-series-\(seriesId)"
    do {
      try await perform { try await api.deleteSeries(seriesId) }
      podStore.removeSeriesPods(seriesId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func openLiveApp(_ podId: String) async {
    do {
      let previewUrl = try await perform { try await api.startPreview(podId) }
      guard let url = URL(string: previewUrl) else { return }
      NSWorkspace.shared.open(url)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func interruptValidation(_ podId: String) async {
    do {
      try await perform { try await api.interruptValidation(podId: podId) }
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func setSkipValidation(_ podId: String, skip: Bool) async {
    do {
      try await perform { try await api.setSkipValidation(podId, skip: skip) }
      try await perform { await podStore.refreshSession(podId) }
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func addValidationOverride(
    _ podId: String,
    findingId: String,
    description: String,
    action: String,
    reason: String?,
    guidance: String?
  ) async {
    do {
      try await perform { try await api.addValidationOverride(
        podId: podId,
        findingId: findingId,
        description: description,
        action: action,
        reason: reason,
        guidance: guidance
      ) }
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func forceApprove(_ podId: String, reason: String?) async {
    do {
      try await perform { try await api.forceApprove(podId, reason: reason) }
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func approveFactWaiver(_ podId: String, factId: String, reason: String?) async {
    do {
      try await perform { try await api.approveFactWaiver(podId: podId, factId: factId, reason: reason) }
      let response = try await perform { try await api.getPod(podId) }
      podStore.upsertSession(PodMapper.map(response))
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func clearError() {
    lastError = nil
  }

  // MARK: - Series

  public func previewSeriesFolder(path: String) async -> SeriesPreviewResponse? {
    lastPreviewError = nil
    do {
      return try await perform { try await api.previewSeriesFolder(path: path) }
    } catch {
      lastPreviewError = error.localizedDescription
      return nil
    }
  }

  public func previewSeriesOnBranch(
    profileName: String, branch: String, path: String
  ) async -> SeriesPreviewResponse? {
    lastPreviewError = nil
    do {
      return try await perform { try await api.previewSeriesOnBranch(
        repositoryId: profileName, branch: branch, path: path
      ) }
    } catch {
      lastPreviewError = error.localizedDescription
      return nil
    }
  }

  public func previewBriefFolder(path: String) async -> ParsedBriefResponse? {
    lastPreviewError = nil
    do {
      return try await perform { try await api.previewBriefFolder(path: path) }
    } catch {
      lastPreviewError = error.localizedDescription
      return nil
    }
  }

  public func previewBriefOnBranch(
    sourcePodId: String, branch: String, path: String
  ) async -> ParsedBriefResponse? {
    lastPreviewError = nil
    do {
      let source = try await perform { try await api.getLaunchConfiguration(sourcePodId) }
      guard let repositoryId = source.fields["repository"]?["id"]?.string else {
        throw DaemonError.networkError("The source workspace has no repository")
      }
      return try await perform { try await api.previewBriefOnBranch(repositoryId: repositoryId, branch: branch, path: path) }
    } catch { lastPreviewError = error.localizedDescription; return nil }
  }

  public func createSeries(_ request: CreateSeriesRequest) async -> String? {
    pendingAction = "create-series"
    lastCreatePodError = nil
    defer { pendingAction = nil }
    do {
      try requireCurrent()
      _ = try LaunchRequestJournal.saveSeries(request, directory: journalRoot?.appendingPathComponent("series", isDirectory: true))
      let response = try await perform { try await api.createSeries(request) }
      for pod in PodMapper.map(response.pods) {
        podStore.upsertSession(pod)
      }
      return response.seriesId
    } catch {
      lastCreatePodError = error.localizedDescription
      return nil
    }
  }

  public func updateFromBase(_ podId: String) async -> UpdateFromBaseResponse? {
    pendingAction = "update-from-base-\(podId)"
    defer { pendingAction = nil }
    do {
      let result = try await perform { try await api.updateFromBase(podId) }
      if result.action == "rebased" || result.action == "queued_after_abort" {
        try await perform { await podStore.refreshSession(podId) }
      }
      return result
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func syncWorkspaceBranch(_ podId: String) async -> SyncBranchResponse? {
    pendingAction = "sync-branch-\(podId)"
    defer { pendingAction = nil }
    do {
      return try await perform { try await api.syncWorkspaceBranch(podId) }
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func launchWorker(_ sourcePodId: String, task: String, brief: BriefPodMetadata?, sidecars: [String]?) async -> String? {
    pendingAction = "launch-worker"; lastCreatePodError = nil
    defer { pendingAction = nil }
    do {
      try requireCurrent()
      guard let pod = podStore.pods.first(where: { $0.id == sourcePodId }) else {
        throw DaemonError.networkError("Source workspace is unavailable")
      }
      var work: [String: ConfigurationJSON] = ["startBranch": .string(pod.branch)]
      if let base = pod.baseBranch { work["baseBranch"] = .string(base) }
      if let brief {
        if let contract = brief.contract { work["contract"] = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(contract)) }
        if let title = brief.briefTitle { work["briefTitle"] = .string(title) }
        if let touches = brief.touches { work["touches"] = .array(touches.map(ConfigurationJSON.string)) }
        if let untouched = brief.doesNotTouch { work["doesNotTouch"] = .array(untouched.map(ConfigurationJSON.string)) }
        if let files = brief.specFiles { work["specFiles"] = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(files)) }
      }
      let draft = ConfigurationJSON.object(["task": .string(task), "work": .object(work),
        "sidecars": .array((sidecars ?? []).sorted().map(ConfigurationJSON.string))])
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      let bytes = try encoder.encode(draft)
      var request: ComposableLaunchRequest
      if let saved = pendingWorkerRequests[sourcePodId], saved.draft == bytes { request = saved.request }
      else {
        let source = try await perform { try await api.getLaunchConfiguration(sourcePodId) }
        if source.fields["repository"]?["id"]?.string != nil {
          let synchronization = try await perform { try await api.syncWorkspaceBranch(sourcePodId) }
          guard synchronization.ok == true, synchronization.pushed == true else {
            throw DaemonError.networkError(synchronization.error ?? "The workspace branch could not be published for the worker. Retry after synchronization succeeds.")
          }
        }
        request = ComposableLaunchRequest(repositoryId: source.fields["repository"]?["id"]?.string,
          profileId: source.fields["profileId"]?.string, task: task)
        request.repositorySetupId = source.fields["repository"]?["setup"]?["id"]?.string
        if request.repositoryId == nil { request.emptyWorkspace = true; work.removeValue(forKey: "startBranch"); work.removeValue(forKey: "baseBranch") }
        request.source = LaunchSource(podId: sourcePodId, digest: source.digest, configuration: "worker")
        request.work = work; request.requiredSidecarIds = sidecars
        request.requestId = UUID().uuidString
        request.expectedDigest = try await perform { try await api.resolveLaunch(request) }.digest
        pendingWorkerRequests[sourcePodId] = (bytes, request)
      }
      try requireCurrent()
      _ = try LaunchRequestJournal.save(request, directory: journalRoot?.appendingPathComponent("launches", isDirectory: true))
      let response = try await perform { try await api.launchPod(request) }
      podStore.upsertSession(PodMapper.map(response))
      pendingWorkerRequests.removeValue(forKey: sourcePodId)
      return response.id
    } catch { lastCreatePodError = error.localizedDescription; return nil }
  }


}

// MARK: - Exact-decision replies

extension ActionHandler {
  private var decisionReplyActions: DecisionReplyActions {
    DecisionReplyActions(
      contextID: replyContextID,
      pod: { [weak self] id in self?.replyPod(id) },
      snapshot: { [weak self] id, decision in self?.replySnapshot(id, decision) ?? .init() },
      isCurrent: { [weak self] id, decision, recordID in
        guard let self, self.podStore.isCurrent(self.ownership),
              let key = self.replyKey(id, decision) else { return false }
        return self.podStore.decisionReplies.read(key)?.id == recordID
      },
      edit: { [weak self] id, decision, text in
        guard let self, let key = self.replyKey(id, decision) else { return }
        self.podStore.decisionReplies.get(key).edit(text)
      },
      discard: { [weak self] id, decision in
        guard let self, let key = self.replyKey(id, decision) else { return }
        self.podStore.decisionReplies.get(key).edit("")
      },
      prepare: { [weak self] id in
        guard let self else { return .unavailable("Connect to load this question.") }
        return await self.prepareReply(id)
      },
      submit: { [weak self] id, decision in
        guard let self else { return Task { .notAdmitted } }
        return self.submitReply(id, decision)
      }
    )
  }

  private func replyPod(_ id: String) -> Pod? {
    guard let replySource, podStore.retainedSource == replySource else { return nil }
    return podStore.pods.first { $0.id == id }
  }

  private func replyKey(_ id: String, _ decision: String?) -> DecisionReplyStore.Key? {
    guard let replySource, let decision, !decision.isEmpty,
          let pod = replyPod(id), pod.status == .awaitingInput,
          pod.escalationId == decision else { return nil }
    return .init(source: replySource, podID: id, decisionID: decision)
  }

  private func replySnapshot(_ id: String, _ decision: String?) -> DecisionReplySnapshot {
    var result = DecisionReplySnapshot()
    guard let key = replyKey(id, decision) else { return result }
    let record = podStore.decisionReplies.read(key)
    result.recordID = record?.id
    result.text = record?.text ?? ""
    result.canEdit = true
    result.pending = podStore.decisionReplies.pending(key) != nil
    result.acknowledged = record?.acknowledged ?? false
    result.canSubmit = podStore.isCurrent(ownership) && !result.pending && !result.acknowledged
    if result.acknowledged {
      result.notice = "Reply acknowledged — waiting for an updated question."
    } else if let notice = record?.notice {
      result.notice = notice
    } else if result.pending {
      result.notice = "Sending reply… Draft kept until acknowledgement."
    } else if !podStore.isCurrent(ownership) {
      result.notice = "Reconnecting — draft kept."
    } else {
      result.notice = record?.notice
    }
    return result
  }

  private func prepareReply(_ id: String) async -> DecisionReplyPreparation {
    do {
      try requireCurrent()
      guard replyPod(id) != nil, let replySource else { return .unavailable("This question is no longer available.") }
      let drafts = podStore.decisionReplies
      let lifetime = drafts.lifetime(source: replySource, podID: id)
      _ = try await podStore.readSession(id, accepting: {
        self.replyPod(id) != nil && drafts.ownsLifetime(source: replySource, podID: id, id: lifetime)
      })
      try requireCurrent()
      guard let pod = replyPod(id), replyKey(id, pod.escalationId) != nil else {
        return .unavailable("No unanswered question is available. Refresh to check again.")
      }
      return .ready
    } catch {
      return .unavailable("Could not load this question. Reconnect or refresh to try again.")
    }
  }

  /// This is intentionally synchronous: capture text/revision and publish admission
  /// before returning to any view. Waiters never own or cancel the shared task.
  private func submitReply(_ id: String, _ decision: String) -> Task<DecisionReplyOutcome, Never> {
    guard let key = replyKey(id, decision) else { return Task { .notAdmitted } }
    let drafts = podStore.decisionReplies
    if let task = drafts.pending(key) { return task }
    let record = drafts.get(key)
    guard !record.acknowledged, podStore.isCurrent(ownership) else {
      return Task { .notAdmitted }
    }
    let message = record.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else { return Task { .notAdmitted } }
    let revision = record.revision
    let attempt = UUID()
    record.attemptID = attempt
    record.notice = nil
    let task = Task { @MainActor [self] in
      defer {
        drafts.settle(key, id: attempt)
        if record.attemptID == attempt {
          record.attemptID = nil
          record.task = nil
        }
      }
      let stillOwnsDecision: @MainActor @Sendable () -> Bool = { [self] in
        podStore.isCurrent(ownership) && drafts.owns(key, record) && replyKey(id, decision) == key
      }
      var postAdmitted = false
      do {
        guard stillOwnsDecision() else { throw CancellationError() }
        let read = try await podStore.readSession(id, accepting: stillOwnsDecision)
        guard stillOwnsDecision(), read.returned.status == .awaitingInput,
              read.returned.escalationId == decision,
              read.current.escalationId == decision else { throw CancellationError() }
        // No suspension between this final authority check and the API call.
        postAdmitted = true
        try await api.sendMessage(id, message: message)
        guard stillOwnsDecision() else { throw CancellationError() }
        record.acknowledged = true
        if record.revision == revision { record.edit("") }
        // Acknowledgement is already visible; refresh cannot revoke it or invent
        // Running. A later decision/source/removal must not be overwritten.
        _ = try? await podStore.readSession(id, accepting: stillOwnsDecision)
        return DecisionReplyOutcome.acknowledged
      } catch {
        if postAdmitted {
          record.notice = "Delivery unconfirmed — draft kept. Inspect activity before retrying."
          if stillOwnsDecision() {
            _ = try? await podStore.readSession(id, accepting: stillOwnsDecision)
          }
          return .unconfirmed
        }
        record.notice = "Reply not sent. Refresh the question before trying again."
        return .notAdmitted
      }
    }
    record.task = task
    drafts.admit(key, id: attempt, task: task)
    return task
  }
}
