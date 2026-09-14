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
  public private(set) var lastError: String?
  /// Error from the most recent preview call, or nil on success. Separate
  /// from lastError so the series sheet doesn't pick up unrelated failures.
  public private(set) var lastPreviewError: String?
  /// Error from the most recent create-pod call. Kept separate from lastError
  /// so creation sheets can show submit failures inline.
  public private(set) var lastCreatePodError: String?

  private let api: DaemonAPI
  private var pendingForkRequests: [String: ComposableLaunchRequest] = [:]
  private var pendingWorkerRequests: [String: (draft: Data, request: ComposableLaunchRequest)] = [:]
  private let podStore: PodStore
  private let profileStore: ProfileStore

  public init(api: DaemonAPI, podStore: PodStore, profileStore: ProfileStore) {
    self.api = api
    self.podStore = podStore
    self.profileStore = profileStore
  }

  /// Build a PodActions struct wired to this handler.
  public var actions: PodActions {
    PodActions(
      approve: { [weak self] id, reason in await self?.approve(id, reason: reason) },
      reject: { [weak self] id, feedback in await self?.reject(id, feedback: feedback) },
      reply: { [weak self] id, message in await self?.reply(id, message: message) },
      nudge: { [weak self] id, message in await self?.nudge(id, message: message) },
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
        do { return try await self.api.getGoal(id) }
        catch DaemonError.notFound { return nil }
      },
      controlGoal: { [weak self] id, request in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.controlGoal(id, body: request)
      },
      loadExecutionProvenance: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.getExecutionProvenance(id)
      },
      loadDispatchPreflight: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.getDispatchPreflight(id)
      },
      loadRerunTemplate: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.getRerunTemplate(id)
      },
      createIntentionalRerun: { [weak self] request in
        guard let self else { throw URLError(.notConnectedToInternet) }
        let response = try await self.api.createIntentionalRerun(request)
        self.podStore.upsertSession(PodMapper.map(response))
        return response.id
      },
      loadRetryState: { [weak self] id, stage in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.getRetryState(id, stage: stage)
      },
      authorizeRetry: { [weak self] id, input in
        guard let self else { throw URLError(.notConnectedToInternet) }
        return try await self.api.authorizeRetry(id, request: input)
      },
      reworkRetry: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        try await self.api.triggerValidation(id)
        await self.podStore.refreshSession(id)
      },
      resumeRetry: { [weak self] id in
        guard let self else { throw URLError(.notConnectedToInternet) }
        _ = try await self.api.resumePod(id)
        await self.podStore.refreshSession(id)
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
  }

  // MARK: - Actions

  public func approve(_ podId: String, reason: String? = nil) async {
    pendingAction = "approve-\(podId)"
    do {
      try await api.approvePod(podId, reason: reason)
      // Status is updated by the daemon event after readiness gates accept the approval.
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func reject(_ podId: String, feedback: String?) async {
    pendingAction = "reject-\(podId)"
    do {
      try await api.rejectPod(podId, feedback: feedback)
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func reply(_ podId: String, message: String) async {
    pendingAction = "reply-\(podId)"
    do {
      try await api.sendMessage(podId, message: message)
      // A reply may leave another decision pending or advance into validation.
      // Keep the observed state until the daemon confirms its actual disposition.
      await podStore.refreshSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func nudge(_ podId: String, message: String) async {
    pendingAction = "nudge-\(podId)"
    do {
      try await api.nudgeSession(podId, message: message)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func kill(_ podId: String) async {
    pendingAction = "kill-\(podId)"
    podStore.updateStatus(podId, to: .killing)
    do {
      try await api.killPod(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func complete(_ podId: String) async {
    pendingAction = "complete-\(podId)"
    do {
      try await api.completeSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func pause(_ podId: String) async {
    pendingAction = "pause-\(podId)"
    podStore.updateStatus(podId, to: .paused)
    do {
      try await api.pauseSession(podId)
    } catch {
      podStore.updateStatus(podId, to: .running)
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func rework(_ podId: String) async {
    pendingAction = "rework-\(podId)"
    do {
      try await api.triggerValidation(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func fixManually(_ podId: String) async -> String? {
    pendingAction = "fix-\(podId)"
    do {
      let workspace = try await api.fixManually(podId)
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
      _ = try await api.revalidateSession(podId)
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func extendAttempts(_ podId: String, additionalAttempts: Int) async {
    pendingAction = "extend-\(podId)"
    do {
      try await api.extendAttempts(podId, additionalAttempts: additionalAttempts)
      // Status will be updated via WebSocket event (back to running/validating)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func extendPrAttempts(_ podId: String, additionalAttempts: Int) async {
    pendingAction = "extend-pr-\(podId)"
    do {
      try await api.extendPrAttempts(podId, additionalAttempts: additionalAttempts)
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
      let response = try await api.spawnFixSession(podId, userMessage: userMessage)
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
      try await api.retryCreatePr(podId)
      await podStore.refreshSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func resume(_ podId: String) async {
    pendingAction = "resume-\(podId)"
    do {
      _ = try await api.resumePod(podId)
      // Resume can flip the pod back to validated (Path 1) or kick off a fresh
      // validation (Path 2). Either way the WebSocket will stream the eventual
      // status — but pull a fresh snapshot now so the UI doesn't sit on `failed`.
      await podStore.refreshSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func recoverWorktree(_ podId: String) async -> RecoverWorktreeResponse? {
    pendingAction = "recover-worktree-\(podId)"
    defer { pendingAction = nil }
    do {
      let result = try await api.recoverWorktree(podId)
      // The daemon clears `worktreeCompromised` on success, so refresh now to
      // re-enable Resume/Rework. On failure the flag stays set; the surfaced
      // message tells the operator what to do next.
      await podStore.refreshSession(podId)
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
      try await api.forceComplete(podId, reason: (trimmed?.isEmpty ?? true) ? nil : trimmed)
      await podStore.refreshSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func kick(_ podId: String, reason: String?) async {
    pendingAction = "kick-\(podId)"
    do {
      let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
      _ = try await api.kickPod(podId, reason: (trimmed?.isEmpty ?? true) ? nil : trimmed)
      // Kick may flip a queued pod back into the active queue (status unchanged)
      // or transition a running pod to failed. Either way refresh now so the
      // UI doesn't sit on the old state until the next WebSocket tick.
      await podStore.refreshSession(podId)
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
      let response = try await api.createPod(req)
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
      try await api.promoteSession(
        podId,
        targetOutput: targetOutput,
        instructions: instructions,
        skipAgent: skipAgent
      )
      // Status will be updated via WebSocket event (running → handoff → provisioning → ...)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func approveAllValidated() async {
    pendingAction = "approve-all"
    do {
      _ = try await api.approveAllValidated()
      await podStore.loadSessions()
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func killAllFailed() async {
    pendingAction = "kill-failed"
    do {
      _ = try await api.killAllFailed()
      await podStore.loadSessions()
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func forkSession(_ podId: String) async -> String? {
    pendingAction = "fork-\(podId)"
    defer { pendingAction = nil }
    do {
      var request: ComposableLaunchRequest
      if let pending = pendingForkRequests[podId] { request = pending }
      else {
        guard let source = podStore.pods.first(where: { $0.id == podId }) else {
          throw DaemonError.networkError("Source pod is unavailable")
        }
        let frozen = try await api.getLaunchConfiguration(podId)
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
        request.expectedDigest = try await api.resolveLaunch(request).digest
        pendingForkRequests[podId] = request
      }
      _ = try LaunchRequestJournal.save(request)
      let response = try await api.launchPod(request)
      podStore.upsertSession(PodMapper.map(response))
      pendingForkRequests.removeValue(forKey: podId)
      lastError = nil
      return response.id
    } catch { lastError = error.localizedDescription; return nil }
  }

  public func deletePod(_ podId: String) async {
    pendingAction = "delete-\(podId)"
    do {
      try await api.deletePod(podId)
      podStore.removeSession(podId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func deleteSeries(_ seriesId: String) async {
    pendingAction = "delete-series-\(seriesId)"
    do {
      try await api.deleteSeries(seriesId)
      podStore.removeSeriesPods(seriesId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func openLiveApp(_ podId: String) async {
    do {
      let previewUrl = try await api.startPreview(podId)
      guard let url = URL(string: previewUrl) else { return }
      NSWorkspace.shared.open(url)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func interruptValidation(_ podId: String) async {
    do {
      try await api.interruptValidation(podId: podId)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func setSkipValidation(_ podId: String, skip: Bool) async {
    do {
      try await api.setSkipValidation(podId, skip: skip)
      await podStore.refreshSession(podId)
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
      try await api.addValidationOverride(
        podId: podId,
        findingId: findingId,
        description: description,
        action: action,
        reason: reason,
        guidance: guidance
      )
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func forceApprove(_ podId: String, reason: String?) async {
    do {
      try await api.forceApprove(podId, reason: reason)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func approveFactWaiver(_ podId: String, factId: String, reason: String?) async {
    do {
      try await api.approveFactWaiver(podId: podId, factId: factId, reason: reason)
      let response = try await api.getPod(podId)
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
      return try await api.previewSeriesFolder(path: path)
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
      return try await api.previewSeriesOnBranch(
        repositoryId: profileName, branch: branch, path: path
      )
    } catch {
      lastPreviewError = error.localizedDescription
      return nil
    }
  }

  public func previewBriefFolder(path: String) async -> ParsedBriefResponse? {
    lastPreviewError = nil
    do {
      return try await api.previewBriefFolder(path: path)
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
      let source = try await api.getLaunchConfiguration(sourcePodId)
      guard let repositoryId = source.fields["repository"]?["id"]?.string else {
        throw DaemonError.networkError("The source workspace has no repository")
      }
      return try await api.previewBriefOnBranch(repositoryId: repositoryId, branch: branch, path: path)
    } catch { lastPreviewError = error.localizedDescription; return nil }
  }

  public func createSeries(_ request: CreateSeriesRequest) async -> String? {
    pendingAction = "create-series"
    lastCreatePodError = nil
    defer { pendingAction = nil }
    do {
      _ = try LaunchRequestJournal.saveSeries(request)
      let response = try await api.createSeries(request)
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
      let result = try await api.updateFromBase(podId)
      if result.action == "rebased" || result.action == "queued_after_abort" {
        await podStore.refreshSession(podId)
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
      return try await api.syncWorkspaceBranch(podId)
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func launchWorker(_ sourcePodId: String, task: String, brief: BriefPodMetadata?, sidecars: [String]?) async -> String? {
    pendingAction = "launch-worker"; lastCreatePodError = nil
    defer { pendingAction = nil }
    do {
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
        let source = try await api.getLaunchConfiguration(sourcePodId)
        if source.fields["repository"]?["id"]?.string != nil {
          let synchronization = try await api.syncWorkspaceBranch(sourcePodId)
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
        request.expectedDigest = try await api.resolveLaunch(request).digest
        pendingWorkerRequests[sourcePodId] = (bytes, request)
      }
      _ = try LaunchRequestJournal.save(request)
      let response = try await api.launchPod(request)
      podStore.upsertSession(PodMapper.map(response))
      pendingWorkerRequests.removeValue(forKey: sourcePodId)
      return response.id
    } catch { lastCreatePodError = error.localizedDescription; return nil }
  }


}
