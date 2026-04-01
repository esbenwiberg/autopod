import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@Test func mapsRunningSession() throws {
  let json = """
  {
    "id": "feat-oauth-a1b2",
    "profileName": "my-app",
    "task": "Add OAuth login",
    "status": "running",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/oauth",
    "containerId": "abc123",
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:05Z",
    "completedAt": null,
    "updatedAt": "2026-04-01T09:05:00Z",
    "userId": "user-1",
    "filesChanged": 5,
    "linesAdded": 89,
    "linesRemoved": 12,
    "previewUrl": "http://localhost:3001",
    "prUrl": null,
    "plan": { "summary": "Add OAuth flow", "steps": ["Setup", "Implement"] },
    "progress": { "phase": "implementation", "description": "Writing routes", "currentPhase": 3, "totalPhases": 5 },
    "acceptanceCriteria": ["Users can sign in"],
    "claudeSessionId": null,
    "outputMode": "pr",
    "baseBranch": null,
    "acFrom": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 15000,
    "outputTokens": 3000,
    "costUsd": 0.42,
    "commitCount": 2,
    "lastCommitAt": null
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let session = SessionMapper.map(response)

  #expect(session.id == "feat-oauth-a1b2")
  #expect(session.status == .running)
  #expect(session.outputMode == .pr)
  #expect(session.branch == "feat/oauth")
  #expect(session.task == "Add OAuth login")
  #expect(session.diffStats?.added == 89)
  #expect(session.diffStats?.removed == 12)
  #expect(session.diffStats?.files == 5)
  #expect(session.phase?.current == 3)
  #expect(session.phase?.total == 5)
  #expect(session.containerUrl?.absoluteString == "http://localhost:3001")
  #expect(session.acceptanceCriteria?.first == "Users can sign in")
  #expect(session.costUsd == 0.42)
  #expect(session.commitCount == 2)
  #expect(session.isWorkspace == false)
}

@Test func mapsAwaitingInputWithEscalation() throws {
  let json = """
  {
    "id": "test-esc",
    "profileName": "webapp",
    "task": "Build login",
    "status": "awaiting_input",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/login",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": {
      "id": "esc-1",
      "sessionId": "test-esc",
      "type": "ask_human",
      "timestamp": "2026-04-01T09:10:00Z",
      "payload": { "question": "Which auth provider?", "options": ["Google", "GitHub"] },
      "response": null
    },
    "escalationCount": 1,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:00Z",
    "completedAt": null,
    "updatedAt": "2026-04-01T09:10:00Z",
    "userId": "user-1",
    "filesChanged": 0,
    "linesAdded": 0,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "acceptanceCriteria": null,
    "claudeSessionId": null,
    "outputMode": "pr",
    "baseBranch": null,
    "acFrom": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 5000,
    "outputTokens": 1000,
    "costUsd": 0.1,
    "commitCount": 0,
    "lastCommitAt": null
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let session = SessionMapper.map(response)

  #expect(session.status == .awaitingInput)
  #expect(session.escalationQuestion == "Which auth provider?")
}

@Test func mapsWorkspaceSession() throws {
  let json = """
  {
    "id": "ws-1",
    "profileName": "my-app",
    "task": "",
    "status": "running",
    "model": "—",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "plan/auth",
    "containerId": "ws-abc",
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": true,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:00Z",
    "completedAt": null,
    "updatedAt": "2026-04-01T09:00:00Z",
    "userId": "user-1",
    "filesChanged": 3,
    "linesAdded": 15,
    "linesRemoved": 0,
    "previewUrl": "http://localhost:3003",
    "prUrl": null,
    "plan": null,
    "progress": null,
    "acceptanceCriteria": null,
    "claudeSessionId": null,
    "outputMode": "workspace",
    "baseBranch": null,
    "acFrom": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "commitCount": 0,
    "lastCommitAt": null
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let session = SessionMapper.map(response)

  #expect(session.isWorkspace == true)
  #expect(session.outputMode == .workspace)
  #expect(session.containerUrl?.absoluteString == "http://localhost:3003")
}
