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
    "runningAt": "2026-04-01T09:00:35Z",
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
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.id == "feat-oauth-a1b2")
  #expect(pod.status == .running)
  #expect(pod.outputMode == .pr)
  #expect(pod.branch == "feat/oauth")
  #expect(pod.task == "Add OAuth login")
  #expect(pod.diffStats?.added == 89)
  #expect(pod.diffStats?.removed == 12)
  #expect(pod.diffStats?.files == 5)
  #expect(pod.phase?.current == 3)
  #expect(pod.phase?.total == 5)
  #expect(pod.containerUrl?.absoluteString == "http://localhost:3001")
  #expect(pod.costUsd == 0.42)
  #expect(pod.commitCount == 2)
  #expect(pod.isWorkspace == false)

  #expect(pod.runningAt == PodMapper.parseDate("2026-04-01T09:00:35Z"))
}

@Test func mapsNullRunningAt() throws {
  let json = """
  {
    "id": "pod-null-rat",
    "profileName": "my-app",
    "task": "test",
    "status": "running",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/x",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:05Z",
    "runningAt": null,
    "completedAt": null,
    "updatedAt": "2026-04-01T09:00:10Z",
    "userId": "user-1",
    "filesChanged": 0,
    "linesAdded": 0,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.runningAt == nil)
}

@Test func mapsMissingRunningAt() throws {
  let json = """
  {
    "id": "pod-missing-rat",
    "profileName": "my-app",
    "task": "test",
    "status": "running",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/x",
    "containerId": null,
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
    "updatedAt": "2026-04-01T09:00:10Z",
    "userId": "user-1",
    "filesChanged": 0,
    "linesAdded": 0,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.runningAt == nil)
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
      "podId": "test-esc",
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
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.status == .awaitingInput)
  #expect(pod.escalationQuestion == "Which auth provider?")
}

@Test func mapsRequestCredentialEscalationReason() throws {
  let json = """
  {
    "id": "test-credential",
    "profileName": "webapp",
    "task": "Push branch",
    "status": "awaiting_input",
    "model": "sonnet",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/credential",
    "containerId": null,
    "worktreePath": "/tmp/worktree",
    "validationAttempts": 1,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": {
      "id": "esc-credential",
      "podId": "test-credential",
      "type": "request_credential",
      "timestamp": "2026-05-20T09:56:24Z",
      "payload": {
        "service": "ado",
        "reason": "git push was rejected by ado. Update the profile's adoPat with a token that has write access to the target repo, then resume the pod.",
        "source": "host_push"
      },
      "response": null
    },
    "escalationCount": 1,
    "skipValidation": false,
    "createdAt": "2026-05-20T09:00:00Z",
    "startedAt": "2026-05-20T09:00:00Z",
    "completedAt": null,
    "updatedAt": "2026-05-20T09:56:24Z",
    "userId": "user-1",
    "filesChanged": 4,
    "linesAdded": 20,
    "linesRemoved": 8,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 5000,
    "outputTokens": 1000,
    "costUsd": 0.1,
    "commitCount": 1,
    "lastCommitAt": null
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let pod = PodMapper.map(response)

  #expect(pod.status == .awaitingInput)
  #expect(pod.escalationType == "request_credential")
  #expect(pod.escalationQuestion?.contains("Update the profile's adoPat") == true)
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
    "claudeSessionId": null,
    "outputMode": "workspace",
    "options": { "agentMode": "interactive", "output": "branch", "validate": false, "promotable": true },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.isWorkspace == true)
  #expect(pod.outputMode == .workspace)
  #expect(pod.containerUrl?.absoluteString == "http://localhost:3003")
}

@Test func mapsPodConfigFromResponse() throws {
  // When `pod` is present, it wins over the legacy `outputMode` string.
  let json = """
  {
    "id": "pod-test",
    "profileName": "my-app",
    "task": "Interactive pod with PR output",
    "status": "running",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/x",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:00Z",
    "completedAt": null,
    "updatedAt": "2026-04-01T09:00:00Z",
    "userId": "user-1",
    "filesChanged": 0,
    "linesAdded": 0,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "workspace",
    "options": { "agentMode": "interactive", "output": "pr", "validate": false, "promotable": true },
    "baseBranch": null,
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
  let pod = PodMapper.map(response)

  #expect(pod.pod.agentMode == .interactive)
  #expect(pod.pod.output == .pr)
  #expect(pod.pod.validate == false)
  #expect(pod.pod.promotable == true)
  #expect(pod.isWorkspace == true)
  #expect(pod.isPromotable == true)
}

/// Regression guard: {interactive, artifact} must round-trip cleanly. Prior to
/// the PodResponse CodingKeys fix the wire field `options` was ignored and the
/// mapper fell back to `outputMode='workspace'`, which coerced the output to
/// `branch` — hiding artifact pods as branch pods and blocking the Markdown tab.
@Test func mapsInteractiveArtifactPodWithArtifactsPath() throws {
  let json = """
  {
    "id": "research-pod",
    "profileName": "ctx",
    "task": "plan the thing",
    "status": "complete",
    "model": "sonnet",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "research/research-pod",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 0,
    "maxValidationAttempts": 3,
    "lastValidationResult": null,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": true,
    "createdAt": "2026-04-21T20:00:00Z",
    "startedAt": "2026-04-21T20:00:00Z",
    "completedAt": "2026-04-21T21:00:00Z",
    "updatedAt": "2026-04-21T21:00:00Z",
    "userId": "user-1",
    "filesChanged": 2,
    "linesAdded": 1639,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "workspace",
    "options": { "agentMode": "interactive", "output": "artifact", "validate": false, "promotable": true },
    "baseBranch": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "commitCount": 0,
    "lastCommitAt": null,
    "artifactsPath": "/Users/ewi/.autopod-data/artifacts/research-pod"
  }
  """.data(using: .utf8)!

  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let pod = PodMapper.map(response)

  #expect(pod.pod.agentMode == .interactive)
  #expect(pod.pod.output == .artifact)
  #expect(pod.isWorkspace == true)
  #expect(pod.artifactsPath == "/Users/ewi/.autopod-data/artifacts/research-pod")
}

// MARK: - Screenshot ref tests (brief 03-desktop)

/// Decoder round-trip: a ScreenshotRefResponse decodes its three fields correctly.
@Test func decodesScreenshotRefResponse() throws {
  let json = """
  {
    "url": "/pods/abc12345/screenshots/smoke/root.png",
    "source": "smoke",
    "path": "/root"
  }
  """.data(using: .utf8)!

  let ref = try JSONDecoder().decode(ScreenshotRefResponse.self, from: json)
  #expect(ref.url == "/pods/abc12345/screenshots/smoke/root.png")
  #expect(ref.source == "smoke")
  #expect(ref.path == "/root")
}

/// Decoder absent fields: a page with no `screenshot` key → nil; empty screenshots array → empty.
@Test func decodesAbsentScreenshotFields() throws {
  // PageResultResponse without screenshot field
  let pageJson = """
  {
    "path": "/root",
    "status": "pass",
    "consoleErrors": [],
    "assertions": [],
    "loadTime": 120
  }
  """.data(using: .utf8)!
  let page = try JSONDecoder().decode(PageResultResponse.self, from: pageJson)
  #expect(page.screenshot == nil)

  // TaskReviewResponse with empty screenshots array
  let reviewJson = """
  {
    "status": "pass",
    "reasoning": "All good",
    "issues": [],
    "model": "claude",
    "screenshots": [],
    "diff": ""
  }
  """.data(using: .utf8)!
  let review = try JSONDecoder().decode(TaskReviewResponse.self, from: reviewJson)
  #expect(review.screenshots.isEmpty)
}

/// Mapper URL resolution: the daemon's relative URL is resolved against the provided base URL.
@Test func mapperResolvesScreenshotURL() throws {
  let sessionJson = """
  {
    "id": "abc12345",
    "profileName": "app",
    "task": "Build feature",
    "status": "complete",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/x",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 1,
    "maxValidationAttempts": 3,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:00Z",
    "completedAt": "2026-04-01T09:10:00Z",
    "updatedAt": "2026-04-01T09:10:00Z",
    "userId": "user-1",
    "filesChanged": 0,
    "linesAdded": 0,
    "linesRemoved": 0,
    "previewUrl": null,
    "prUrl": null,
    "plan": null,
    "progress": null,
    "claudeSessionId": null,
    "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "commitCount": 1,
    "lastCommitAt": null,
    "lastValidationResult": {
      "podId": "abc12345",
      "attempt": 1,
      "timestamp": "2026-04-01T09:08:00Z",
      "overall": "pass",
      "duration": 30000,
      "smoke": {
        "status": "pass",
        "build": { "status": "pass", "output": "", "duration": 5000 },
        "health": { "status": "pass", "url": "http://localhost:3001", "responseCode": 200, "duration": 200 },
        "pages": [
          {
            "path": "/root",
            "status": "pass",
            "consoleErrors": [],
            "assertions": [],
            "loadTime": 300,
            "screenshot": {
              "url": "/pods/abc12345/screenshots/smoke/root.png",
              "source": "smoke",
              "path": "/root"
            }
          }
        ]
      }
    }
  }
  """.data(using: .utf8)!

  let baseURL = URL(string: "http://127.0.0.1:3100")!
  let response = try JSONDecoder().decode(SessionResponse.self, from: sessionJson)
  let pod = PodMapper.map(response, baseURL: baseURL)

  let screenshot = pod.validationChecks?.proofOfWorkScreenshots?.first
  #expect(screenshot != nil)
  #expect(screenshot?.url.absoluteString == "http://127.0.0.1:3100/pods/abc12345/screenshots/smoke/root.png")
  #expect(screenshot?.source == .smoke)
  #expect(screenshot?.label == "/root")
}

/// Set ordering: smoke → ac → review refs from a full validation result map through in canonical order.
@Test func mapperPreservesScreenshotSetOrdering() throws {
  let sessionJson = """
  {
    "id": "ord-test",
    "profileName": "app",
    "task": "Test ordering",
    "status": "complete",
    "model": "opus",
    "runtime": "claude",
    "executionTarget": "local",
    "branch": "feat/ord",
    "containerId": null,
    "worktreePath": null,
    "validationAttempts": 1,
    "maxValidationAttempts": 3,
    "pendingEscalation": null,
    "escalationCount": 0,
    "skipValidation": false,
    "createdAt": "2026-04-01T09:00:00Z",
    "startedAt": "2026-04-01T09:00:00Z",
    "completedAt": "2026-04-01T09:10:00Z",
    "updatedAt": "2026-04-01T09:10:00Z",
    "userId": "user-1",
    "filesChanged": 0, "linesAdded": 0, "linesRemoved": 0,
    "previewUrl": null, "prUrl": null,
    "plan": null, "progress": null,
    "claudeSessionId": null, "outputMode": "pr",
    "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
    "baseBranch": null, "recoveryWorktreePath": null, "lastHeartbeatAt": null,
    "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "commitCount": 0, "lastCommitAt": null,
    "lastValidationResult": {
      "podId": "ord-test",
      "attempt": 1,
      "timestamp": "2026-04-01T09:08:00Z",
      "overall": "pass",
      "duration": 10000,
      "smoke": {
        "status": "pass",
        "build": { "status": "pass", "output": "", "duration": 1000 },
        "health": { "status": "pass", "url": "http://localhost:3001", "responseCode": 200, "duration": 100 },
        "pages": [
          {
            "path": "/about",
            "status": "pass",
            "consoleErrors": [],
            "assertions": [],
            "loadTime": 100,
            "screenshot": { "url": "/pods/ord-test/screenshots/smoke/about.png", "source": "smoke", "path": "/about" }
          },
          {
            "path": "/root",
            "status": "pass",
            "consoleErrors": [],
            "assertions": [],
            "loadTime": 90,
            "screenshot": { "url": "/pods/ord-test/screenshots/smoke/root.png", "source": "smoke", "path": "/root" }
          }
        ]
      },
      "taskReview": {
        "status": "pass",
        "reasoning": "good",
        "issues": [],
        "model": "claude",
        "diff": "",
        "screenshots": [
          { "url": "/pods/ord-test/screenshots/review/0.png", "source": "review", "path": "0" }
        ]
      }
    }
  }
  """.data(using: .utf8)!

  let baseURL = URL(string: "http://127.0.0.1:3100")!
  let response = try JSONDecoder().decode(SessionResponse.self, from: sessionJson)
  let pod = PodMapper.map(response, baseURL: baseURL)

  // proofOfWorkScreenshots = smoke only (2 pages), in page order
  let pow = pod.validationChecks?.proofOfWorkScreenshots
  #expect(pow?.count == 2)
  #expect(pow?.first?.source == .smoke)
  #expect(pow?.first?.label == "/about")  // first page in JSON
  #expect(pow?.last?.label == "/root")

  // Review screenshots
  let reviewShots = pod.validationChecks?.taskReviewScreenshots
  #expect(reviewShots?.count == 1)
  #expect(reviewShots?.first?.source == .review)

  // Combined canonical ordering (mirrors ValidationTab.screenshotSet: smoke -> review).
  // This is the array the lightbox receives for arrow-key navigation.
  let combined: [ScreenshotRef] =
    (pod.validationChecks?.proofOfWorkScreenshots ?? []) +
    (pod.validationChecks?.taskReviewScreenshots ?? [])
  #expect(combined.count == 3)
  #expect(combined.map(\.source) == [.smoke, .smoke, .review])
  #expect(combined[0].label == "/about")
  #expect(combined[1].label == "/root")
  #expect(combined[2].label == "0")
}

// MARK: - hasWebUi mapping tests (brief 02)

private let minimalSessionJson = """
{
  "id": "web-ui-pod",
  "profileName": "webapp",
  "task": "Build UI",
  "status": "running",
  "model": "opus",
  "runtime": "claude",
  "executionTarget": "local",
  "branch": "feat/x",
  "containerId": null,
  "worktreePath": null,
  "validationAttempts": 0,
  "maxValidationAttempts": 3,
  "lastValidationResult": null,
  "pendingEscalation": null,
  "escalationCount": 0,
  "skipValidation": false,
  "createdAt": "2026-04-01T09:00:00Z",
  "startedAt": "2026-04-01T09:00:00Z",
  "completedAt": null,
  "updatedAt": "2026-04-01T09:00:10Z",
  "userId": "user-1",
  "filesChanged": 0,
  "linesAdded": 0,
  "linesRemoved": 0,
  "previewUrl": "http://localhost:3001",
  "prUrl": null,
  "plan": null,
  "progress": null,
  "claudeSessionId": null,
  "outputMode": "pr",
  "options": { "agentMode": "auto", "output": "pr", "validate": true, "promotable": false },
  "baseBranch": null,
  "recoveryWorktreePath": null,
  "lastHeartbeatAt": null,
  "inputTokens": 0,
  "outputTokens": 0,
  "costUsd": 0,
  "commitCount": 0,
  "lastCommitAt": null
"""

/// `hasWebUi: true` in the JSON → `pod.hasWebUi == true`.
@Test func mapsHasWebUiTrue() throws {
  let json = (minimalSessionJson + ", \"hasWebUi\": true }").data(using: .utf8)!
  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let pod = PodMapper.map(response)
  #expect(pod.hasWebUi == true)
}

/// `hasWebUi: false` in the JSON → `pod.hasWebUi == false`.
@Test func mapsHasWebUiFalse() throws {
  let json = (minimalSessionJson + ", \"hasWebUi\": false }").data(using: .utf8)!
  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let pod = PodMapper.map(response)
  #expect(pod.hasWebUi == false)
}

/// `hasWebUi` absent from the JSON → defaults to `false` (defensive back-compat).
@Test func mapsHasWebUiMissingDefaultsFalse() throws {
  let json = (minimalSessionJson + " }").data(using: .utf8)!
  let response = try JSONDecoder().decode(SessionResponse.self, from: json)
  let pod = PodMapper.map(response)
  #expect(pod.hasWebUi == false)
}
