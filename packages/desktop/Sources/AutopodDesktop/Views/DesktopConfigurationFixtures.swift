import AutopodClient
import Foundation

/// Fictional, memory-only records for reviewing the native desktop configuration UI.
enum DesktopConfigurationFixtures {
  static func document(
    _ kind: ConfigurationKind, id: String, name: String,
    payload: [String: ConfigurationJSON], revision: Int = 1
  ) throws -> ConfigurationDocument {
    let value: ConfigurationJSON = .object([
      "id": .string(id), "kind": .string(kind.rawValue), "name": .string(name),
      "revision": .number(Double(revision)), "archived": .bool(false),
      "createdAt": .string("2026-10-17T10:00:00Z"), "updatedAt": .string("2026-10-17T12:00:00Z"),
      "payload": .object(payload),
    ])
    return try JSONDecoder().decode(ConfigurationDocument.self, from: Data(value.formatted().utf8))
  }

  static var documents: [ConfigurationDocument] {
    do {
      let route: ConfigurationJSON = .object([
        "providerAccountId": .string("fixture-engineering"),
        "runtime": .string("codex"), "model": .string("gpt-5.6-sol"), "reasoningEffort": .string("high"),
        "maxHops": .number(1),
        "failover": .array([
          .object([
            "providerAccountId": .string("fixture-review"), "runtime": .string("claude"),
            "model": .string("claude-opus-4-6"), "reasoningEffort": .string("auto"),
          ])
        ]),
      ])
      let definitions: [(ConfigurationKind, String, String, [String: ConfigurationJSON])] = [
        (
          .environment, "env-backend", ".NET 10 + Go",
          [
            "template": .string("dotnet10-go"), "tools": .array([]),
            "prepareCommands": .array([.string("dotnet restore")]), "sidecars": .array([
              .object(["id": .string("database"), "type": .string("postgres"),
                "image": .string("postgres@sha256:" + String(repeating: "a", count: 64)), "version": .string("17"),
                "startup": .string("on-demand"), "port": .number(5432), "healthTimeoutMs": .number(60000)]),
              .object(["id": .string("cache"), "type": .string("redis"),
                "image": .string("redis@sha256:" + String(repeating: "b", count: 64)), "version": .string("7"),
                "startup": .string("always"), "port": .number(6379), "healthTimeoutMs": .number(60000)]),
            ]),
            "capabilities": .array([.string("dotnet"), .string("go")]),
          ]
        ),
        (
          .environment, "env-web", "Node 22 + Playwright",
          [
            "template": .string("node22-pw"),
            "tools": .array([.object(["name": .string("pnpm"), "version": .string("10.11.0")])]),
            "sidecars": .array([]), "capabilities": .array([.string("node"), .string("playwright")]),
          ]
        ),
        (
          .ai, "ai-careful", "Codex · careful review",
          ["main": route, "reviewer": .object(["mode": .string("independent"), "route": route])]
        ),
        (
          .ai, "ai-research", "Codex · research",
          ["main": route, "reviewer": .object(["mode": .string("follow-main")])]
        ),
        (
          .workflow, "workflow-pr", "Build, test & approval",
          [
            "agentMode": .string("auto"), "intent": .string("task"), "output": .string("pr"),
            "completion": .string("approval"),
            "validationPhases": .array(
              ["setup", "lint", "sast", "build", "test", "health", "review"].map(ConfigurationJSON.string)),
            "tokenBudget": .number(100000), "reviewerTokenBudget": .number(10000),
            "tokenBudgetPolicy": .string("hard"),
          ]
        ),
        (
          .workflow, "workflow-research", "Research to artifact",
          [
            "agentMode": .string("auto"), "intent": .string("task"), "output": .string("artifact"),
            "completion": .string("approval"), "validationPhases": .array([.string("review")]),
          ]
        ),
        (
          .githubAccess, "access-current", "Current repo · read + checks",
          [
            "rules": .array([
              .object([
                "id": .string("read"), "repositories": .object(["mode": .string("current")]),
                "operations": .array([.string("code.read"), .string("checks.read")]),
              ])
            ])
          ]
        ),
        (
          .toolPack, "tools-engineering", "Engineering essentials",
          [
            "instructions": .array([
              .object([
                "heading": .string("Project guidance"),
                "content": .string("Read repository guidance before editing."),
              ])
            ]), "skills": .array([]), "mcpServers": .array([]),
            "requiredCapabilities": .array([.string("node")]),
          ]
        ),
        (
          .profile, "profile-backend", "Backend delivery",
          profile(environment: "env-backend", ai: "ai-careful", workflow: "workflow-pr")
        ),
        (
          .profile, "profile-frontend", "Frontend delivery",
          profile(environment: "env-web", ai: "ai-careful", workflow: "workflow-pr")
        ),
        (
          .profile, "profile-research", "Research & artifacts",
          profile(environment: "env-web", ai: "ai-research", workflow: "workflow-research")
        ),
        (
          .repository, "repo-backend", "acme/autopod",
          repository(remote: "https://github.com/acme/autopod.git", profile: "profile-backend")
        ),
        (
          .repository, "repo-web", "acme/desktop-app",
          repository(remote: "https://github.com/acme/desktop-app.git", profile: "profile-frontend")
        ),
        (
          .repository, "repo-research", "acme/runbooks",
          repository(remote: "https://github.com/acme/runbooks.git", profile: "profile-research")
        ),
      ]
      return try definitions.map { try document($0.0, id: $0.1, name: $0.2, payload: $0.3) }
    } catch { preconditionFailure("Invalid native configuration fixture: \(error)") }
  }

  private static func profile(environment: String, ai: String, workflow: String) -> [String:
    ConfigurationJSON]
  {
    [
      "environmentId": .string(environment), "aiId": .string(ai), "workflowId": .string(workflow),
      "githubAccessId": .string("access-current"), "toolPackIds": .array([.string("tools-engineering")]),
      "execution": .object([
        "target": .string("local"),
        "main": .object(["memoryGb": .number(4), "cpus": .number(2), "storageGb": .null]),
        "sidecars": .object([:]),
      ]), "pim": .array([]), "workerProfileId": .null,
      "futureFixtureField": .object(["preserve": .bool(true)]),
    ]
  }

  private static func repository(remote: String, profile: String) -> [String: ConfigurationJSON] {
    [
      "provider": .string("github"), "remote": .string(remote), "usualProfileId": .string(profile),
      "defaultSetupId": .string("default"), "trustedSetupIds": .array([]),
      "setups": .array([
        .object([
          "id": .string("default"), "name": .string("Application"), "defaultBranch": .string("main"),
          "buildCommand": .string("npm run build"), "testCommand": .string("npm test"),
        ])
      ]),
    ]
  }

  static var capabilities: ConfigurationJSON {
    .object(["execution": .array([
      .object([
        "target": .string("local"), "available": .bool(true), "sidecars": .bool(true),
        "privilegedSidecars": .bool(false), "sidecarStorageLimit": .bool(false),
        "maxMemoryGb": .number(16), "maxCpus": .number(8), "maxStorageGb": .null,
        "maxTotalMemoryGb": .number(16), "maxTotalCpus": .number(8),
        "sidecarDefaults": .object([
          "postgres": .object(["memoryGb": .number(1), "cpus": .number(1)]),
          "redis": .object(["memoryGb": .number(0.5), "cpus": .number(0.5)]),
        ]),
      ]),
      .object([
        "target": .string("sandbox"), "available": .bool(true), "sidecars": .bool(false),
        "privilegedSidecars": .bool(false), "sidecarStorageLimit": .bool(false),
        "maxMemoryGb": .number(16), "maxCpus": .null, "maxStorageGb": .null,
        "maxTotalMemoryGb": .number(16), "memoryTiersGb": .array([2, 4, 8, 16].map { .number(Double($0)) }),
      ]),
    ])])
  }

  static var accounts: [PublicProviderAccountResponse] {
    let json =
      #"[{"id":"fixture-engineering","name":"Engineering (sample)","provider":"openai","hasCredentials":false,"createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T10:00:00Z"},{"id":"fixture-review","name":"Review (sample)","provider":"anthropic","hasCredentials":false,"createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T10:00:00Z"}]"#
    do { return try JSONDecoder().decode([PublicProviderAccountResponse].self, from: Data(json.utf8)) } catch
    { preconditionFailure("Invalid provider-account fixture: \(error)") }
  }
}
