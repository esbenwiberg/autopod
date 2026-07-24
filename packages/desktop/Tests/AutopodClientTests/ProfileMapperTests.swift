import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@Test func profileMapperMapsNilAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(advisoryBrowserQaFragment: "")

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == nil)
}

@Test func profileMapperMapsTrueAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": true"#
  )

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == true)
}

@Test func profileMapperMapsFalseAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": false"#
  )

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == false)
}

@Test func profilePatchOmitsNilAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: nil)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] == nil)
}

@Test func profilePatchIncludesTrueAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: true)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] as? Bool == true)
}

@Test func profilePatchIncludesFalseAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: false)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] as? Bool == false)
}

@Test func profileResponseDecodesValidationSetupCommand() throws {
  let response = try decodeMapperProfile(validationSetupCommand: "pip install semgrep")

  #expect(response.validationSetupCommand == "pip install semgrep")
}

@Test func profileMapperMapsValidationSetupCommand() throws {
  let response = try decodeMapperProfile(validationSetupCommand: "uv pip install ruff mypy")
  let profile = ProfileMapper.map(response)

  #expect(profile.validationSetupCommand == "uv pip install ruff mypy")
}

@Test func profilePatchIncludesValidationSetupCommandWhenSet() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    validationSetupCommand: "pip install semgrep"
  )

  let fields = ProfileMapper.mapToFields(profile)
  #expect(fields["validationSetupCommand"] as? String == "pip install semgrep")
}

@Test func profilePatchClearsNilValidationSetupCommandWithoutDefault() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    validationSetupCommand: nil
  )

  let fields = ProfileMapper.mapToFields(profile)
  #expect(fields["validationSetupCommand"] is NSNull)
}

@Test func profileMapperCanonicalizesLegacyProfileModelAliases() throws {
  let profile = try decodeMapperProfile(
    defaultModel: "opus",
    reviewerModel: "sonnet",
    askAiModel: "haiku"
  )
  let mapped = ProfileMapper.map(profile)

  #expect(mapped.defaultModel == "claude-opus-4-8")
  #expect(mapped.reviewerModel == "claude-sonnet-4-6")
  #expect(mapped.escalationAskAiModel == "claude-haiku-4-5")
}

@Test func profileMapperWritesReviewerModelToLegacyAskAiModelField() throws {
  let profile = try decodeMapperProfile(
    defaultModel: "claude-opus-4-8",
    reviewerModel: "claude-sonnet-4-6",
    askAiModel: "claude-haiku-4-5"
  )
  let mapped = ProfileMapper.map(profile)
  let fields = ProfileMapper.mapToFields(mapped)
  let escalation = fields["escalation"] as? [String: Any]
  let askAi = escalation?["askAi"] as? [String: Any]

  #expect(mapped.escalationAskAiModel == "claude-haiku-4-5")
  #expect(askAi?["model"] as? String == "claude-sonnet-4-6")
}

@Test func profileMapperPreservesExplicitCanonicalOpus47() throws {
  let profile = try decodeMapperProfile(
    defaultModel: "claude-opus-4-7",
    reviewerModel: "claude-opus-4-7",
    askAiModel: "claude-opus-4-7"
  )
  let mapped = ProfileMapper.map(profile)
  let fields = ProfileMapper.mapToFields(mapped)
  let escalation = fields["escalation"] as? [String: Any]
  let askAi = escalation?["askAi"] as? [String: Any]

  #expect(mapped.defaultModel == "claude-opus-4-7")
  #expect(mapped.reviewerModel == "claude-opus-4-7")
  #expect(askAi?["model"] as? String == "claude-opus-4-7")
}

@Test func profileMapperUsesCanonicalReviewerFallbackWhenReviewerMissing() throws {
  let json = """
  {
    "name": "app",
    "defaultModel": "claude-opus-4-8",
    "escalation": {
      "askHuman": true,
      "askAi": { "enabled": true, "model": "claude-opus-4-7", "maxCalls": 3 },
      "autoPauseAfter": 1,
      "humanResponseTimeout": 3600
    },
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(ProfileResponse.self, from: json)
  let mapped = ProfileMapper.map(response)
  let fields = ProfileMapper.mapToFields(mapped)
  let escalation = fields["escalation"] as? [String: Any]
  let askAi = escalation?["askAi"] as? [String: Any]

  #expect(mapped.defaultModel == "claude-opus-4-8")
  #expect(mapped.reviewerModel == "claude-sonnet-4-6")
  #expect(mapped.escalationAskAiModel == "claude-opus-4-7")
  #expect(askAi?["model"] as? String == "claude-sonnet-4-6")
}

@Test func profileMapperRoundTripsProviderAccountId() throws {
  let json = """
  {
    "name": "app",
    "modelProvider": "openai",
    "providerAccountId": "team-openai",
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(ProfileResponse.self, from: json)
  let mapped = ProfileMapper.map(response)
  let fields = ProfileMapper.mapToFields(mapped)

  #expect(mapped.providerAccountId == "team-openai")
  #expect(fields["providerAccountId"] as? String == "team-openai")
}

@Test func profileMapperRoundTripsProviderFailoverOverride() throws {
  let json = """
  {
    "name": "app",
    "providerFailover": {
      "targets": [
        { "providerAccountId": "openai-pro", "runtime": "codex", "model": "gpt-5.6-terra" },
        { "providerAccountId": "copilot", "runtime": "copilot", "model": "auto" }
      ],
      "maxHops": 2
    },
    "version": 1,
    "createdAt": "2026-07-24T00:00:00Z",
    "updatedAt": "2026-07-24T00:00:00Z"
  }
  """.data(using: .utf8)!
  let response = try JSONDecoder().decode(ProfileResponse.self, from: json)
  let mapped = ProfileMapper.map(response)
  let fields = ProfileMapper.mapToFields(mapped)
  let policy = fields["providerFailover"] as? [String: Any]
  let targets = policy?["targets"] as? [[String: String]]

  #expect(mapped.providerFailover?.targets.map(\.providerAccountId) == ["openai-pro", "copilot"])
  #expect(policy?["maxHops"] as? Int == 2)
  #expect(targets?.first?["runtime"] == "codex")
  #expect(targets?.first?["model"] == "gpt-5.6-terra")
}

@Test func profileMapperEncodesExplicitEmptyFailoverOverrideAndLegacyNil() throws {
  let response = try JSONDecoder().decode(
    ProfileResponse.self,
    from: Data(
      #"{"name":"legacy","version":1,"createdAt":"","updatedAt":""}"#.utf8
    )
  )
  let inherited = ProfileMapper.map(response)
  #expect(inherited.providerFailover == nil)
  #expect(ProfileMapper.mapToFields(inherited)["providerFailover"] is NSNull)

  var disabled = inherited
  disabled.providerFailover = ProviderFailoverPolicyResponse(targets: [])
  let policy = ProfileMapper.mapToFields(disabled)["providerFailover"] as? [String: Any]
  #expect((policy?["targets"] as? [[String: String]])?.isEmpty == true)
}

private func decodeMapperProfile(advisoryBrowserQaFragment: String) throws -> ProfileResponse {
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

private func decodeMapperProfile(validationSetupCommand: String?) throws -> ProfileResponse {
  let setupFragment: String
  if let validationSetupCommand {
    setupFragment = #","validationSetupCommand": "\#(validationSetupCommand)""#
  } else {
    setupFragment = #","validationSetupCommand": null"#
  }
  let json = """
  {
    "name": "app"\(setupFragment),
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!

  return try JSONDecoder().decode(ProfileResponse.self, from: json)
}

private func decodeMapperProfile(
  defaultModel: String,
  reviewerModel: String,
  askAiModel: String
) throws -> ProfileResponse {
  let json = """
  {
    "name": "app",
    "defaultModel": "\(defaultModel)",
    "reviewerModel": "\(reviewerModel)",
    "escalation": {
      "askHuman": true,
      "askAi": { "enabled": true, "model": "\(askAiModel)", "maxCalls": 3 },
      "autoPauseAfter": 1,
      "humanResponseTimeout": 3600
    },
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!

  return try JSONDecoder().decode(ProfileResponse.self, from: json)
}
