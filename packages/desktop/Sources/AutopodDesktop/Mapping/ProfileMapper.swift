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

    // Action policy
    let ap = response.actionPolicy
    let enabledGroups: Set<ActionGroup> = Set(
      (ap?.enabledGroups ?? []).compactMap { ActionGroup(rawValue: $0) }
    )
    let enabledActions: Set<String> = Set(ap?.enabledActions ?? [])
    let actionOverrides: [ActionOverride] = (ap?.actionOverrides ?? []).map {
      ActionOverride(
        action: $0.action,
        allowedResources: $0.allowedResources ?? [],
        requiresApproval: $0.requiresApproval ?? false,
        disabled: $0.disabled ?? false
      )
    }

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
      allowPackageManagers: response.networkPolicy?.allowPackageManagers ?? false,
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
      escalationAskHuman: response.escalation.askHuman,
      escalationAskAiEnabled: response.escalation.askAi.enabled,
      escalationAskAiModel: response.escalation.askAi.model,
      escalationAskAiMaxCalls: response.escalation.askAi.maxCalls,
      escalationAutoPauseAfter: response.escalation.autoPauseAfter,
      escalationHumanResponseTimeout: response.escalation.humanResponseTimeout,
      outputMode: OutputMode(rawValue: response.outputMode) ?? .pr,
      extendsProfile: response.extends,
      workerProfile: response.workerProfile,
      warmImageTag: response.warmImageTag,
      warmImageBuiltAt: response.warmImageBuiltAt,
      actionPolicyEnabled: ap != nil,
      actionEnabledGroups: enabledGroups,
      actionEnabledActions: enabledActions,
      actionOverrides: actionOverrides,
      actionSanitizationPreset: SanitizationPreset(rawValue: ap?.sanitization.preset ?? "standard") ?? .standard,
      actionSanitizationAllowedDomains: ap?.sanitization.allowedDomains ?? [],
      actionQuarantineEnabled: ap?.quarantine?.enabled ?? false,
      actionQuarantineThreshold: ap?.quarantine?.threshold ?? 0.5,
      actionQuarantineBlockThreshold: ap?.quarantine?.blockThreshold ?? 0.8,
      actionQuarantineOnBlock: QuarantineOnBlock(rawValue: ap?.quarantine?.onBlock ?? "ask_human") ?? .askHuman,
      providerCredentialsType: response.providerCredentials?.provider,
      version: response.version,
      createdAt: SessionMapper.parseDate(response.createdAt),
      updatedAt: SessionMapper.parseDate(response.updatedAt)
    )
  }

  public static func map(_ responses: [ProfileResponse]) -> [Profile] {
    responses.map { map($0) }
  }

  // MARK: - Profile → partial update dictionary

  /// Build a dictionary of fields the editor can round-trip safely.
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
      "outputMode": profile.outputMode.rawValue,
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
    if let v = profile.extendsProfile { d["extends"] = v }
    if let v = profile.workerProfile { d["workerProfile"] = v }

    // Escalation
    d["escalation"] = [
      "askHuman": profile.escalationAskHuman,
      "askAi": [
        "enabled": profile.escalationAskAiEnabled,
        "model": profile.escalationAskAiModel,
        "maxCalls": profile.escalationAskAiMaxCalls,
      ] as [String: Any],
      "autoPauseAfter": profile.escalationAutoPauseAfter,
      "humanResponseTimeout": profile.escalationHumanResponseTimeout,
    ] as [String: Any]

    // Network policy
    if profile.networkEnabled {
      var np: [String: Any] = [
        "enabled": true,
        "mode": profile.networkMode.rawValue,
        "allowedHosts": profile.allowedHosts,
      ]
      if profile.allowPackageManagers {
        np["allowPackageManagers"] = true
      }
      d["networkPolicy"] = np
    } else {
      d["networkPolicy"] = ["enabled": false, "mode": "restricted", "allowedHosts": []] as [String: Any]
    }

    // Action policy
    if profile.actionPolicyEnabled {
      var ap: [String: Any] = [
        "enabledGroups": profile.actionEnabledGroups.map(\.rawValue),
        "sanitization": [
          "preset": profile.actionSanitizationPreset.rawValue,
          "allowedDomains": profile.actionSanitizationAllowedDomains,
        ] as [String: Any],
      ]
      if !profile.actionEnabledActions.isEmpty {
        ap["enabledActions"] = Array(profile.actionEnabledActions).sorted()
      }
      if !profile.actionOverrides.isEmpty {
        ap["actionOverrides"] = profile.actionOverrides.map { o -> [String: Any] in
          var entry: [String: Any] = ["action": o.action]
          if !o.allowedResources.isEmpty { entry["allowedResources"] = o.allowedResources }
          if o.requiresApproval { entry["requiresApproval"] = true }
          if o.disabled { entry["disabled"] = true }
          return entry
        }
      }
      if profile.actionQuarantineEnabled {
        ap["quarantine"] = [
          "enabled": true,
          "threshold": profile.actionQuarantineThreshold,
          "blockThreshold": profile.actionQuarantineBlockThreshold,
          "onBlock": profile.actionQuarantineOnBlock.rawValue,
        ] as [String: Any]
      }
      d["actionPolicy"] = ap
    } else {
      d["actionPolicy"] = NSNull()
    }

    return d
  }
}
