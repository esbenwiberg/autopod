import Foundation
import AutopodClient
import AutopodUI

/// Maps daemon ProfileResponse ↔ AutopodUI Profile display model.
public enum ProfileMapper {

  // MARK: - ProfileResponse → Profile

  public static func map(_ response: ProfileResponse) -> Profile {
    let template = StackTemplate(rawValue: response.template) ?? .custom
    let runtime = RuntimeType(rawValue: response.defaultRuntime) ?? .claude
    let target = ExecutionTarget(rawValue: response.executionTarget) ?? .local
    let provider = ModelProvider(rawValue: response.modelProvider) ?? .anthropic
    let prProvider = PRProvider(rawValue: response.prProvider) ?? .github
    let networkMode = response.networkPolicy.flatMap { NetworkPolicyMode(rawValue: $0.mode ?? "restricted") } ?? .restricted

    return Profile(
      name: response.name,
      repoUrl: response.repoUrl,
      defaultBranch: response.defaultBranch,
      template: template,
      buildCommand: response.buildCommand,
      startCommand: response.startCommand,
      testCommand: response.testCommand,
      healthPath: response.healthPath,
      healthTimeout: response.healthTimeout,
      buildTimeout: response.buildTimeout,
      testTimeout: response.testTimeout,
      maxValidationAttempts: response.maxValidationAttempts,
      defaultModel: response.defaultModel,
      defaultRuntime: runtime,
      executionTarget: target,
      modelProvider: provider,
      prProvider: prProvider,
      customInstructions: response.customInstructions,
      containerMemoryGb: response.containerMemoryGb,
      hasGithubPat: response.githubPat != nil,
      hasAdoPat: response.adoPat != nil,
      hasRegistryPat: response.registryPat != nil,
      networkEnabled: response.networkPolicy?.enabled ?? false,
      networkMode: networkMode,
      allowedHosts: response.networkPolicy?.allowedHosts ?? [],
      privateRegistries: response.privateRegistries.map {
        PrivateRegistry(type: RegistryType(rawValue: $0.type) ?? .npm, url: $0.url, scope: $0.scope)
      },
      smokePages: response.smokePages.map { SmokePage(path: $0.path) },
      mcpServers: response.mcpServers.map {
        InjectedMcpServer(name: $0.name, url: $0.url ?? "", description: $0.description)
      },
      claudeMdSections: response.claudeMdSections.map {
        InjectedClaudeMdSection(heading: $0.heading ?? "", content: $0.content ?? "")
      },
      skills: response.skills.map {
        InjectedSkill(name: $0.name ?? "", description: $0.description)
      },
      createdAt: SessionMapper.parseDate(response.createdAt),
      updatedAt: SessionMapper.parseDate(response.updatedAt)
    )
  }

  public static func map(_ responses: [ProfileResponse]) -> [Profile] {
    responses.map { map($0) }
  }

  // MARK: - Profile → partial update dictionary

  /// Build a dictionary of fields the editor can round-trip safely.
  /// Complex nested types that the UI doesn't fully model (escalation, skills.source)
  /// are excluded — the PATCH endpoint only updates fields present in the body.
  public static func mapToFields(_ profile: Profile) -> [String: Any] {
    var d: [String: Any] = [
      "repoUrl": profile.repoUrl,
      "defaultBranch": profile.defaultBranch,
      "template": profile.template.rawValue,
      "buildCommand": profile.buildCommand,
      "startCommand": profile.startCommand,
      "healthPath": profile.healthPath,
      "healthTimeout": profile.healthTimeout,
      "maxValidationAttempts": profile.maxValidationAttempts,
      "defaultModel": profile.defaultModel,
      "defaultRuntime": profile.defaultRuntime.rawValue,
      "executionTarget": profile.executionTarget.rawValue,
      "modelProvider": profile.modelProvider.rawValue,
      "buildTimeout": profile.buildTimeout,
      "testTimeout": profile.testTimeout,
      "prProvider": profile.prProvider.rawValue,
      "smokePages": profile.smokePages.map { ["path": $0.path] },
      "privateRegistries": profile.privateRegistries.map {
        var r: [String: Any] = ["type": $0.type.rawValue, "url": $0.url]
        if let scope = $0.scope { r["scope"] = scope }
        return r
      },
      "allowedHosts": profile.allowedHosts,
    ]

    // Optional fields — only include if set
    if let v = profile.customInstructions { d["customInstructions"] = v }
    if let v = profile.testCommand { d["testCommand"] = v }
    if let v = profile.containerMemoryGb { d["containerMemoryGb"] = v }
    if let v = profile.githubPat { d["githubPat"] = v }
    if let v = profile.adoPat { d["adoPat"] = v }
    if let v = profile.registryPat { d["registryPat"] = v }

    // Network policy
    if profile.networkEnabled {
      d["networkPolicy"] = [
        "enabled": true,
        "mode": profile.networkMode.rawValue,
        "allowedHosts": profile.allowedHosts,
      ] as [String: Any]
    } else {
      d["networkPolicy"] = ["enabled": false, "mode": "restricted", "allowedHosts": []] as [String: Any]
    }

    return d
  }
}
