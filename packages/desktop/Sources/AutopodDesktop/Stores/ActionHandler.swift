import Foundation
import AppKit
import AutopodClient
import AutopodUI

/// Executes session actions against the daemon API with optimistic UI updates.
@Observable
@MainActor
public final class ActionHandler {

  public private(set) var pendingAction: String?
  public private(set) var lastError: String?

  private let api: DaemonAPI
  private let sessionStore: SessionStore
  private let profileStore: ProfileStore

  public init(api: DaemonAPI, sessionStore: SessionStore, profileStore: ProfileStore) {
    self.api = api
    self.sessionStore = sessionStore
    self.profileStore = profileStore
  }

  /// Build a SessionActions struct wired to this handler.
  public var actions: SessionActions {
    SessionActions(
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
      createSession: { [weak self] profile, task, model, output, ac, base, acFrom, pimGroups in
        await self?.createSession(
          profileName: profile, task: task, model: model,
          outputMode: output, acceptanceCriteria: ac,
          baseBranch: base, acFrom: acFrom, pimGroups: pimGroups
        )
      },
      approveAll: { [weak self] in await self?.approveAllValidated() },
      killAllFailed: { [weak self] in await self?.killAllFailed() },
      extendAttempts: { [weak self] id, count in await self?.extendAttempts(id, additionalAttempts: count) },
      fork: { [weak self] id in await self?.forkSession(id) },
      delete: { [weak self] id in await self?.deleteSession(id) },
      createHistoryWorkspace: { [weak self] profile, limit in
        await self?.createHistoryWorkspace(profileName: profile, limit: limit)
      },
      openLiveApp: { [weak self] id in await self?.openLiveApp(id) },
      workerProfileForProfile: { [weak self] name in
        self?.profileStore.profiles.first(where: { $0.name == name })?.workerProfile
      },
      interruptValidation: { [weak self] id in await self?.interruptValidation(id) },
      addValidationOverride: { [weak self] id, fid, desc, action, reason, guidance in
        await self?.addValidationOverride(id, findingId: fid, description: desc, action: action, reason: reason, guidance: guidance)
      }
    )
  }

  // MARK: - Actions

  public func approve(_ sessionId: String) async {
    pendingAction = "approve-\(sessionId)"
    sessionStore.updateStatus(sessionId, to: .approved)
    do {
      try await api.approveSession(sessionId)
    } catch {
      sessionStore.updateStatus(sessionId, to: .validated)
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func reject(_ sessionId: String, feedback: String?) async {
    pendingAction = "reject-\(sessionId)"
    do {
      try await api.rejectSession(sessionId, feedback: feedback)
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func reply(_ sessionId: String, message: String) async {
    pendingAction = "reply-\(sessionId)"
    sessionStore.setEscalation(sessionId, question: nil)
    sessionStore.updateStatus(sessionId, to: .running)
    do {
      try await api.sendMessage(sessionId, message: message)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func nudge(_ sessionId: String, message: String) async {
    pendingAction = "nudge-\(sessionId)"
    do {
      try await api.nudgeSession(sessionId, message: message)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func kill(_ sessionId: String) async {
    pendingAction = "kill-\(sessionId)"
    sessionStore.updateStatus(sessionId, to: .killing)
    do {
      try await api.killSession(sessionId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func complete(_ sessionId: String) async {
    pendingAction = "complete-\(sessionId)"
    do {
      try await api.completeSession(sessionId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func pause(_ sessionId: String) async {
    pendingAction = "pause-\(sessionId)"
    sessionStore.updateStatus(sessionId, to: .paused)
    do {
      try await api.pauseSession(sessionId)
    } catch {
      sessionStore.updateStatus(sessionId, to: .running)
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func rework(_ sessionId: String) async {
    pendingAction = "rework-\(sessionId)"
    do {
      try await api.triggerValidation(sessionId)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func fixManually(_ sessionId: String) async -> String? {
    pendingAction = "fix-\(sessionId)"
    do {
      let workspace = try await api.fixManually(sessionId)
      let session = SessionMapper.map(workspace)
      sessionStore.upsertSession(session)
      pendingAction = nil
      return workspace.id
    } catch {
      lastError = error.localizedDescription
      pendingAction = nil
      return nil
    }
  }

  public func revalidate(_ sessionId: String) async {
    pendingAction = "revalidate-\(sessionId)"
    do {
      _ = try await api.revalidateSession(sessionId)
      // Status will be updated via WebSocket event
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func extendAttempts(_ sessionId: String, additionalAttempts: Int) async {
    pendingAction = "extend-\(sessionId)"
    do {
      try await api.extendAttempts(sessionId, additionalAttempts: additionalAttempts)
      // Status will be updated via WebSocket event (back to running/validating)
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func createSession(
    profileName: String, task: String, model: String?,
    outputMode: String?, acceptanceCriteria: [String]?,
    baseBranch: String?, acFrom: String?, pimGroups: [PimGroupRequest]? = nil
  ) async -> String? {
    pendingAction = "create"
    let req = CreateSessionRequest(
      profileName: profileName,
      task: task,
      model: model?.isEmpty == true ? nil : model,
      acceptanceCriteria: acceptanceCriteria?.filter { !$0.isEmpty },
      outputMode: outputMode,
      baseBranch: baseBranch?.isEmpty == true ? nil : baseBranch,
      acFrom: acFrom?.isEmpty == true ? nil : acFrom,
      pimGroups: pimGroups?.filter { !$0.groupId.isEmpty }
    )
    do {
      let response = try await api.createSession(req)
      let session = SessionMapper.map(response)
      sessionStore.upsertSession(session)
      pendingAction = nil
      return response.id
    } catch {
      lastError = error.localizedDescription
      pendingAction = nil
      return nil
    }
  }

  public func approveAllValidated() async {
    pendingAction = "approve-all"
    do {
      _ = try await api.approveAllValidated()
      await sessionStore.loadSessions()
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func killAllFailed() async {
    pendingAction = "kill-failed"
    do {
      _ = try await api.killAllFailed()
      await sessionStore.loadSessions()
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func forkSession(_ sessionId: String) async -> String? {
    pendingAction = "fork-\(sessionId)"
    guard let source = sessionStore.sessions.first(where: { $0.id == sessionId }) else {
      lastError = "Session \(sessionId) not found"
      pendingAction = nil
      return nil
    }
    // Create a new session with the same config, using the source branch as baseBranch
    let result = await createSession(
      profileName: source.profileName,
      task: source.task,
      model: source.model,
      outputMode: source.outputMode.rawValue,
      acceptanceCriteria: source.acceptanceCriteria,
      baseBranch: source.branch,
      acFrom: source.acFrom
    )
    pendingAction = nil
    return result
  }

  public func deleteSession(_ sessionId: String) async {
    pendingAction = "delete-\(sessionId)"
    do {
      try await api.deleteSession(sessionId)
      sessionStore.removeSession(sessionId)
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
      let session = SessionMapper.map(response)
      sessionStore.upsertSession(session)
      sessionStore.selectedSessionId = session.id
    } catch {
      lastError = error.localizedDescription
    }
    pendingAction = nil
  }

  public func openLiveApp(_ sessionId: String) async {
    do {
      let previewUrl = try await api.startPreview(sessionId)
      guard let url = URL(string: previewUrl) else { return }
      NSWorkspace.shared.open(url)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func interruptValidation(_ sessionId: String) async {
    do {
      try await api.interruptValidation(sessionId: sessionId)
    } catch {
      lastError = error.localizedDescription
    }
  }

  public func addValidationOverride(
    _ sessionId: String,
    findingId: String,
    description: String,
    action: String,
    reason: String?,
    guidance: String?
  ) async {
    do {
      try await api.addValidationOverride(
        sessionId: sessionId,
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

  public func clearError() {
    lastError = nil
  }
}
