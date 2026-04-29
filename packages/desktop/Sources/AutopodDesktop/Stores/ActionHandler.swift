import Foundation
import AppKit
import AutopodClient
import AutopodUI

/// Executes pod actions against the daemon API with optimistic UI updates.
@Observable
@MainActor
public final class ActionHandler {

  public private(set) var pendingAction: String?
  public private(set) var lastError: String?
  /// Error from the most recent preview call, or nil on success. Separate
  /// from lastError so the series sheet doesn't pick up unrelated failures.
  public private(set) var lastPreviewError: String?

  private let api: DaemonAPI
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
      approve: { [weak self] id in await self?.approve(id) },
      reject: { [weak self] id, feedback in await self?.reject(id, feedback: feedback) },
      reply: { [weak self] id, message in await self?.reply(id, message: message) },
      nudge: { [weak self] id, message in await self?.nudge(id, message: message) },
      kill: { [weak self] id in await self?.kill(id) },
      complete: { [weak self] id in await self?.complete(id) },
      pause: { [weak self] id in await self?.pause(id) },
      rework: { [weak self] id in await self?.rework(id) },
      fixManually: { [weak self] id in await self?.fixManually(id) },
      revalidate: { [weak self] id in await self?.revalidate(id) },
      createPod: { [weak self] profile, task, model, pod, ac, base, acFrom, pimGroups, sidecars, refRepos in
        await self?.createPod(
          profileName: profile, task: task, model: model,
          pod: pod, acceptanceCriteria: ac,
          baseBranch: base, acFrom: acFrom, pimGroups: pimGroups,
          requireSidecars: sidecars,
          referenceRepos: refRepos
        )
      },
      promote: { [weak self] id, target in await self?.promoteSession(id, targetOutput: target) },
      approveAll: { [weak self] in await self?.approveAllValidated() },
      killAllFailed: { [weak self] in await self?.killAllFailed() },
      extendAttempts: { [weak self] id, count in await self?.extendAttempts(id, additionalAttempts: count) },
      extendPrAttempts: { [weak self] id, count in await self?.extendPrAttempts(id, additionalAttempts: count) },
      fork: { [weak self] id in await self?.forkSession(id) },
      delete: { [weak self] id in await self?.deletePod(id) },
      deleteSeries: { [weak self] id in await self?.deleteSeries(id) },
      createHistoryWorkspace: { [weak self] profile, limit in
        await self?.createHistoryWorkspace(profileName: profile, limit: limit)
      },
      createMemoryWorkspace: { [weak self] profile in
        await self?.createMemoryWorkspace(profileName: profile)
      },
      openLiveApp: { [weak self] id in await self?.openLiveApp(id) },
      workerProfileForProfile: { [weak self] name in
        self?.profileStore.profiles.first(where: { $0.name == name })?.workerProfile
      },
      interruptValidation: { [weak self] id in await self?.interruptValidation(id) },
      setSkipValidation: { [weak self] id, skip in await self?.setSkipValidation(id, skip: skip) },
      addValidationOverride: { [weak self] id, fid, desc, action, reason, guidance in
        await self?.addValidationOverride(id, findingId: fid, description: desc, action: action, reason: reason, guidance: guidance)
      },
      forceApprove: { [weak self] id, reason in await self?.forceApprove(id, reason: reason) },
      spawnFix: { [weak self] id, message in await self?.spawnFixSession(id, userMessage: message) },
      retryCreatePr: { [weak self] id in await self?.retryCreatePr(id) },
      previewSeriesFolder: { [weak self] path in
        await self?.previewSeriesFolder(path: path) ?? nil
      },
      previewSeriesOnBranch: { [weak self] profile, branch, path in
        await self?.previewSeriesOnBranch(profileName: profile, branch: branch, path: path) ?? nil
      },
      lastPreviewError: { [weak self] in self?.lastPreviewError },
      createSeries: { [weak self] request in
        await self?.createSeries(request) ?? nil
      },
      spawnDependent: { [weak self] profile, task, parents, seriesId, seriesName, ac, base in
        await self?.spawnDependent(
          profileName: profile,
          task: task,
          dependsOnPodIds: parents,
          seriesId: seriesId,
          seriesName: seriesName,
          acceptanceCriteria: ac,
          baseBranch: base
        ) ?? nil
      }
    )
  }

  // MARK: - Actions

  public func approve(_ podId: String) async {
    pendingAction = "approve-\(podId)"
    podStore.updateStatus(podId, to: .approved)
    do {
      try await api.approvePod(podId)
    } catch {
      podStore.updateStatus(podId, to: .validated)
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
    podStore.setEscalation(podId, question: nil)
    podStore.updateStatus(podId, to: .running)
    do {
      try await api.sendMessage(podId, message: message)
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

  public func spawnFixSession(_ podId: String, userMessage: String? = nil) async {
    pendingAction = "spawn-fix-\(podId)"
    do {
      try await api.spawnFixSession(podId, userMessage: userMessage)
      // Fix pod will appear via WebSocket pod.created event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
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

  public func createPod(
    profileName: String, task: String, model: String?,
    pod: PodConfigRequest?, acceptanceCriteria: [AcDefinition]?,
    baseBranch: String?, acFrom: String?, pimGroups: [PimGroupRequest]? = nil,
    requireSidecars: [String]? = nil,
    referenceRepos: [ReferenceRepoRequest]? = nil
  ) async -> String? {
    pendingAction = "create"
    let req = CreateSessionRequest(
      profileName: profileName,
      task: task,
      model: model?.isEmpty == true ? nil : model,
      acceptanceCriteria: acceptanceCriteria?.filter { !$0.test.isEmpty },
      pod: pod,
      baseBranch: baseBranch?.isEmpty == true ? nil : baseBranch,
      acFrom: acFrom?.isEmpty == true ? nil : acFrom,
      pimGroups: pimGroups?.filter { !$0.groupId.isEmpty },
      requireSidecars: (requireSidecars?.isEmpty ?? true) ? nil : requireSidecars,
      referenceRepos: (referenceRepos?.isEmpty ?? true) ? nil : referenceRepos
    )
    do {
      let response = try await api.createPod(req)
      let pod = PodMapper.map(response)
      podStore.upsertSession(pod)
      pendingAction = nil
      return response.id
    } catch {
      lastError = error.localizedDescription
      pendingAction = nil
      return nil
    }
  }

  public func promoteSession(_ podId: String, targetOutput: String?) async {
    pendingAction = "promote-\(podId)"
    do {
      try await api.promoteSession(podId, targetOutput: targetOutput)
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
    guard let source = podStore.pods.first(where: { $0.id == podId }) else {
      lastError = "Pod \(podId) not found"
      pendingAction = nil
      return nil
    }
    // Create a new pod with the same config, using the source branch as baseBranch
    let result = await createPod(
      profileName: source.profileName,
      task: source.task,
      model: source.model,
      pod: PodConfigRequest(
        agentMode: source.pod.agentMode.rawValue,
        output: source.pod.output.rawValue,
        validate: source.pod.validate,
        promotable: source.pod.promotable
      ),
      acceptanceCriteria: source.acceptanceCriteria,
      baseBranch: source.branch,
      acFrom: source.acFrom
    )
    pendingAction = nil
    return result
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

  public func createMemoryWorkspace(profileName: String) async {
    pendingAction = "memory-workspace"
    do {
      let response = try await api.createMemoryWorkspace(profileName: profileName)
      let pod = PodMapper.map(response)
      podStore.upsertSession(pod)
      podStore.selectedSessionId = pod.id
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func createHistoryWorkspace(profileName: String?, limit: Int) async {
    pendingAction = "history-workspace"
    do {
      let response = try await api.createHistoryWorkspace(
        profileName: profileName,
        limit: limit
      )
      let pod = PodMapper.map(response)
      podStore.upsertSession(pod)
      podStore.selectedSessionId = pod.id
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
        profileName: profileName, branch: branch, path: path
      )
    } catch {
      lastPreviewError = error.localizedDescription
      return nil
    }
  }

  public func createSeries(_ request: CreateSeriesRequest) async -> String? {
    pendingAction = "create-series"
    defer { pendingAction = nil }
    do {
      let response = try await api.createSeries(request)
      for pod in PodMapper.map(response.pods) {
        podStore.upsertSession(pod)
      }
      return response.seriesId
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  public func spawnDependent(
    profileName: String,
    task: String,
    dependsOnPodIds: [String],
    seriesId: String?,
    seriesName: String?,
    acceptanceCriteria: [AcDefinition]?,
    baseBranch: String?
  ) async -> String? {
    pendingAction = "spawn-dependent"
    defer { pendingAction = nil }
    let req = CreateSessionRequest(
      profileName: profileName,
      task: task,
      acceptanceCriteria: acceptanceCriteria?.filter { !$0.test.isEmpty },
      pod: PodConfigRequest(agentMode: "auto", output: "pr", validate: true, promotable: false),
      baseBranch: baseBranch?.isEmpty == true ? nil : baseBranch,
      dependsOnPodIds: dependsOnPodIds,
      seriesId: seriesId,
      seriesName: seriesName
    )
    do {
      let response = try await api.createPod(req)
      let pod = PodMapper.map(response)
      podStore.upsertSession(pod)
      return response.id
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }
}
