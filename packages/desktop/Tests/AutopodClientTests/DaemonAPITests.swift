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
    "claudeSessionId": null,
    "outputMode": "pr",
    "baseBranch": null,
    "recoveryWorktreePath": null,
    "lastHeartbeatAt": null,
    "inputTokens": 15000,
    "outputTokens": 3000,
    "costUsd": 0.42,
    "commitCount": 2,
    "lastCommitAt": "2026-04-01T09:04:00Z"
  }
  """.data(using: .utf8)!

  let pod = try JSONDecoder().decode(SessionResponse.self, from: json)
  #expect(pod.id == "feat-oauth-a1b2")
  #expect(pod.status == "running")
  #expect(pod.plan?.steps.count == 2)
  #expect(pod.progress?.currentPhase == 3)
  #expect(pod.costUsd == 0.42)
  #expect(pod.commitCount == 2)
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
    "adoPatExpiresAt": null,
    "githubPat": "encrypted-value",
    "githubPatExpiresAt": "2026-06-01",
    "privateRegistries": [],
    "registryPat": null,
    "registryPatExpiresAt": null,
    "containerMemoryGb": 4.0,
    "version": 1,
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
  #expect(profile.githubPatExpiresAt == "2026-06-01")
  #expect(profile.containerMemoryGb == 4.0)
}

@Test func profileResponseDecodesAdvisoryBrowserQaNil() throws {
  let profile = try decodeProfileWithAdvisoryBrowserQa(advisoryBrowserQaFragment: "")

  #expect(profile.pod?.advisoryBrowserQaEnabled == nil)
}

@Test func profileResponseDecodesAdvisoryBrowserQaTrue() throws {
  let profile = try decodeProfileWithAdvisoryBrowserQa(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": true"#
  )

  #expect(profile.pod?.advisoryBrowserQaEnabled == true)
}

@Test func profileResponseDecodesAdvisoryBrowserQaFalse() throws {
  let profile = try decodeProfileWithAdvisoryBrowserQa(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": false"#
  )

  #expect(profile.pod?.advisoryBrowserQaEnabled == false)
}

@Test func validationResponseDecodes() throws {
  let json = """
  {
    "podId": "test-1",
    "attempt": 1,
    "timestamp": "2026-04-01T09:10:00Z",
    "setup": { "status": "pass", "output": "tools installed", "duration": 15 },
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
    "taskReview": {
      "status": "pass",
      "reasoning": "Implementation looks correct",
      "issues": [],
      "model": "opus",
      "screenshots": [],
      "diff": "diff --git a/foo.ts b/foo.ts\\n...",
      "requirementsCheck": [{ "criterion": "Login works", "met": true, "note": null }]
    },
    "advisoryBrowserQa": {
      "status": "error",
      "reasoning": "Exploratory browser QA found polish issues.",
      "model": "gpt-5",
      "durationMs": 2500,
      "observations": [{
        "id": "advisory-1",
        "scenarioId": "scenario-login",
        "status": "fail",
        "summary": "Login form overflows on mobile",
        "details": "The submit button is clipped at 390px width.",
        "screenshots": [{
          "url": "/pods/test-1/screenshots/advisory/advisory-0.png",
          "source": "advisory",
          "path": "advisory-0"
        }],
        "suggestedFacts": ["Add a responsive login viewport fact."]
      }],
      "screenshots": [{
        "url": "/pods/test-1/screenshots/advisory/advisory-0.png",
        "source": "advisory",
        "path": "advisory-0"
      }]
    },
    "overall": "pass",
    "duration": 180
  }
  """.data(using: .utf8)!

  let result = try JSONDecoder().decode(ValidationResponse.self, from: json)
  #expect(result.overall == "pass")
  #expect(result.setup?.status == "pass")
  #expect(result.setup?.output == "tools installed")
  #expect(result.smoke.pages.count == 1)
  #expect(result.test?.status == "pass")
  #expect(result.taskReview?.requirementsCheck?.first?.met == true)
  #expect(result.advisoryBrowserQa?.status == "error")
  #expect(result.advisoryBrowserQa?.observations.first?.suggestedFacts?.count == 1)
  #expect(result.advisoryBrowserQa?.screenshots.first?.source == "advisory")
}

@Test func validationResponseDecodesHistoricalWithoutSetup() throws {
  let json = """
  {
    "podId": "historical-1",
    "attempt": 1,
    "timestamp": "2026-04-01T09:10:00Z",
    "smoke": {
      "status": "pass",
      "build": { "status": "pass", "output": "", "duration": 45 },
      "health": { "status": "skip", "url": "", "responseCode": null, "duration": 0 },
      "pages": []
    },
    "overall": "pass",
    "duration": 180
  }
  """.data(using: .utf8)!

  let result = try JSONDecoder().decode(ValidationResponse.self, from: json)
  #expect(result.setup == nil)
  #expect(result.smoke.build.status == "pass")
}

@Test func systemEventParsesSetupPhaseCompletion() throws {
  let json = """
  {
    "type": "pod.validation_phase_completed",
    "timestamp": "2026-04-01T09:10:00Z",
    "podId": "test-1",
    "phase": "setup",
    "phaseStatus": "fail",
    "setupResult": {
      "status": "fail",
      "output": "pip install -e .",
      "duration": 1234,
      "error": "ruff not found"
    }
  }
  """.data(using: .utf8)!

  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: json)
  let event = SystemEvent.parse(raw)

  switch event {
  case .validationPhaseCompleted(let id, let phase, let result):
    #expect(id == "test-1")
    #expect(phase == .setup)
    #expect(result.phaseStatus == "fail")
    #expect(result.setupResult?.error == "ruff not found")
  default:
    Issue.record("Expected validationPhaseCompleted event")
  }
}

@Test func advisoryBrowserQaResponseDecodesSkippedStatus() throws {
  let json = """
  {
    "status": "skipped",
    "reasoning": "No web UI was available for advisory browser QA.",
    "model": null,
    "durationMs": 5,
    "observations": [],
    "screenshots": []
  }
  """.data(using: .utf8)!

  let result = try JSONDecoder().decode(AdvisoryBrowserQaResponse.self, from: json)
  #expect(result.status == "skipped")
  #expect(result.reasoning == "No web UI was available for advisory browser QA.")
  #expect(result.observations.isEmpty)
}

private func decodeProfileWithAdvisoryBrowserQa(
  advisoryBrowserQaFragment: String
) throws -> ProfileResponse {
  let json = """
  {
    "name": "app",
    "pod": {
      "agentMode": "auto",
      "output": "pr",
      "validate": true\(advisoryBrowserQaFragment),
      "promotable": false
    },
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!

  return try JSONDecoder().decode(ProfileResponse.self, from: json)
}

@Test func systemEventParses() throws {
  let json = """
  {
    "type": "pod.status_changed",
    "timestamp": "2026-04-01T09:05:00Z",
    "_eventId": 42,
    "podId": "test-1",
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
  let contract = SpecContractResponse(
    contractVersion: 1,
    title: "Brief contract",
    dependsOn: [],
    scenarios: [
      ContractScenarioResponse(
        id: "scenario-ui",
        given: ["A user opens New Pod"],
        when: ["They preview a brief"],
        then: ["The contract metadata is sent"]
      ),
    ],
    requiredFacts: [
      RequiredFactResponse(
        id: "fact-wire",
        proves: ["scenario-ui"],
        kind: "unit-test",
        artifact: FactArtifactResponse(path: "Tests/WireTests.swift", change: "update"),
        command: "swift test --filter WireTests"
      ),
    ],
    humanReview: []
  )
  let req = CreateSessionRequest(
    profileName: "my-app",
    task: "Add OAuth login",
    model: "opus",
    contract: contract,
    briefTitle: "Brief contract",
    touches: ["packages/desktop/Sources/AutopodUI"],
    doesNotTouch: ["packages/daemon/src/pods/pod-manager.ts"],
    outputMode: "pr"
  )

  let data = try JSONEncoder().encode(req)
  let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  #expect(dict["profileName"] as? String == "my-app")
  #expect(dict["task"] as? String == "Add OAuth login")
  #expect(dict["model"] as? String == "opus")
  #expect(dict["briefTitle"] as? String == "Brief contract")
  #expect(dict["touches"] as? [String] == ["packages/desktop/Sources/AutopodUI"])
  #expect(dict["doesNotTouch"] as? [String] == ["packages/daemon/src/pods/pod-manager.ts"])
  let encodedContract = dict["contract"] as? [String: Any]
  #expect(encodedContract?["title"] as? String == "Brief contract")
  #expect((encodedContract?["requiredFacts"] as? [[String: Any]])?.first?["id"] as? String == "fact-wire")
  // Optional fields should not be present when nil
  #expect(dict["branch"] == nil)
  #expect(dict["runtime"] == nil)
}
