import Foundation
import Testing
@testable import AutopodClient

// MARK: - Basic init

@Test func daemonAPIInitializes() async throws {
  let api = DaemonAPI(
    baseURL: URL(string: "http://localhost:3000")!,
    token: "test-token"
  )
  let url = await api.baseURL
  #expect(url.absoluteString == "http://localhost:3000")
}

// MARK: - Response decoding tests

@Test func sessionResponseDecodes() throws {
  let json = """
  {
    "id": "feat-oauth-a1b2",
    "profileName": "my-app",
    "task": "Add OAuth",
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
    "previewUrl": null,
    "prUrl": null,
    "plan": { "summary": "Add OAuth flow", "steps": ["Setup routes", "Add middleware"] },
    "progress": { "phase": "implementation", "description": "Writing routes", "currentPhase": 3, "totalPhases": 5 },
    "acceptanceCriteria": ["Users can sign in with Google"],
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
    "lastCommitAt": "2026-04-01T09:04:00Z"
  }
  """.data(using: .utf8)!

  let session = try JSONDecoder().decode(SessionResponse.self, from: json)
  #expect(session.id == "feat-oauth-a1b2")
  #expect(session.status == "running")
  #expect(session.plan?.steps.count == 2)
  #expect(session.progress?.currentPhase == 3)
  #expect(session.acceptanceCriteria?.first == "Users can sign in with Google")
  #expect(session.costUsd == 0.42)
  #expect(session.commitCount == 2)
}

@Test func profileResponseDecodes() throws {
  let json = """
  {
    "name": "my-app",
    "repoUrl": "https://github.com/org/my-app.git",
    "defaultBranch": "main",
    "template": "node22-pw",
    "buildCommand": "pnpm build",
    "startCommand": "pnpm start",
    "healthPath": "/api/health",
    "healthTimeout": 120,
    "smokePages": [{ "path": "/" }, { "path": "/login" }],
    "maxValidationAttempts": 3,
    "defaultModel": "opus",
    "defaultRuntime": "claude",
    "executionTarget": "local",
    "customInstructions": null,
    "escalation": {
      "askHuman": true,
      "askAi": { "enabled": false, "model": "sonnet", "maxCalls": 3 },
      "autoPauseAfter": 5,
      "humanResponseTimeout": 300
    },
    "extends": null,
    "warmImageTag": null,
    "warmImageBuiltAt": null,
    "mcpServers": [],
    "claudeMdSections": [],
    "skills": [],
    "networkPolicy": { "enabled": true, "mode": "restricted", "allowedHosts": ["api.stripe.com"] },
    "actionPolicy": null,
    "outputMode": "pr",
    "modelProvider": "anthropic",
    "providerCredentials": null,
    "testCommand": "pnpm test",
    "buildTimeout": 300,
    "testTimeout": 600,
    "prProvider": "github",
    "adoPat": null,
    "githubPat": "encrypted-value",
    "privateRegistries": [],
    "registryPat": null,
    "containerMemoryGb": 4.0,
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-04-01T00:00:00Z"
  }
  """.data(using: .utf8)!

  let profile = try JSONDecoder().decode(ProfileResponse.self, from: json)
  #expect(profile.name == "my-app")
  #expect(profile.template == "node22-pw")
  #expect(profile.smokePages.count == 2)
  #expect(profile.networkPolicy?.mode == "restricted")
  #expect(profile.networkPolicy?.allowedHosts.first == "api.stripe.com")
  #expect(profile.githubPat == "encrypted-value")
  #expect(profile.containerMemoryGb == 4.0)
}

@Test func validationResponseDecodes() throws {
  let json = """
  {
    "sessionId": "test-1",
    "attempt": 1,
    "timestamp": "2026-04-01T09:10:00Z",
    "smoke": {
      "status": "pass",
      "build": { "status": "pass", "output": "Build OK", "duration": 45 },
      "health": { "status": "pass", "url": "http://localhost:3001/health", "responseCode": 200, "duration": 2 },
      "pages": [{
        "path": "/",
        "status": "pass",
        "screenshotPath": "/tmp/ss.png",
        "screenshotBase64": null,
        "consoleErrors": [],
        "assertions": [],
        "loadTime": 350
      }]
    },
    "test": { "status": "pass", "duration": 120, "stdout": "All tests passed", "stderr": null },
    "acValidation": null,
    "taskReview": {
      "status": "pass",
      "reasoning": "Implementation looks correct",
      "issues": [],
      "model": "opus",
      "screenshots": [],
      "diff": "diff --git a/foo.ts b/foo.ts\\n...",
      "requirementsCheck": [{ "criterion": "Login works", "met": true, "note": null }]
    },
    "overall": "pass",
    "duration": 180
  }
  """.data(using: .utf8)!

  let result = try JSONDecoder().decode(ValidationResponse.self, from: json)
  #expect(result.overall == "pass")
  #expect(result.smoke.pages.count == 1)
  #expect(result.test?.status == "pass")
  #expect(result.taskReview?.requirementsCheck?.first?.met == true)
}

@Test func systemEventParses() throws {
  let json = """
  {
    "type": "session.status_changed",
    "timestamp": "2026-04-01T09:05:00Z",
    "_eventId": 42,
    "sessionId": "test-1",
    "previousStatus": "running",
    "newStatus": "validating"
  }
  """.data(using: .utf8)!

  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: json)
  let event = SystemEvent.parse(raw)

  switch event {
  case .statusChanged(let id, let from, let to):
    #expect(id == "test-1")
    #expect(from == "running")
    #expect(to == "validating")
  default:
    Issue.record("Expected statusChanged event")
  }
}

@Test func createSessionRequestEncodes() throws {
  let req = CreateSessionRequest(
    profileName: "my-app",
    task: "Add OAuth login",
    model: "opus",
    acceptanceCriteria: ["Users can log in"],
    outputMode: "pr"
  )

  let data = try JSONEncoder().encode(req)
  let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  #expect(dict["profileName"] as? String == "my-app")
  #expect(dict["task"] as? String == "Add OAuth login")
  #expect(dict["model"] as? String == "opus")
  #expect((dict["acceptanceCriteria"] as? [String])?.first == "Users can log in")
  // Optional fields should not be present when nil
  #expect(dict["branch"] == nil)
  #expect(dict["runtime"] == nil)
}
