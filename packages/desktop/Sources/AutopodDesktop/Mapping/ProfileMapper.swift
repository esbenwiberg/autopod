import Foundation
import AutopodClient
import AutopodUI

/// Maps daemon ProfileResponse ↔ AutopodUI Profile display model.
public enum ProfileMapper {

  // MARK: - ProfileResponse → Profile

  public static func map(_ response: ProfileResponse) -> Profile {
    let template = StackTemplate(rawValue: response.template ?? "") ?? .custom
    let runtime = RuntimeType(rawValue: response.defaultRuntime ?? "") ?? .claude
    let target = ExecutionTarget(rawValue: response.executionTarget ?? "") ?? .local
    let provider = ModelProvider(rawValue: response.modelProvider ?? "") ?? .anthropic
    let prProvider = PRProvider(rawValue: response.prProvider ?? "") ?? .github
    let networkMode = response.networkPolicy.flatMap { NetworkPolicyMode(rawValue: $0.mode ?? "restricted") } ?? .restricted
    let escalation = response.escalation ?? EscalationConfigResponse()

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
      repoUrl: response.repoUrl ?? "",
      defaultBranch: response.defaultBranch ?? "main",
      template: template,
      buildCommand: response.buildCommand ?? "",
      startCommand: response.startCommand ?? "",
      buildWorkDir: response.buildWorkDir,
      testCommand: response.testCommand,
      buildEnv: response.buildEnv ?? [:],
      lintCommand: response.lintCommand,
      lintTimeout: response.lintTimeout,
      sastCommand: response.sastCommand,
      sastTimeout: response.sastTimeout,
      mergePollIntervalSec: response.mergePollIntervalSec,
      fixPodCooldownSec: response.fixPodCooldownSec,
      reuseFixPod: response.reuseFixPod ?? false,
      healthPath: response.healthPath ?? "/",
      healthTimeout: response.healthTimeout ?? 120,
      buildTimeout: response.buildTimeout ?? 300,
      testTimeout: response.testTimeout ?? 600,
      maxValidationAttempts: response.maxValidationAttempts ?? 3,
      defaultModel: response.defaultModel ?? "opus",
      reviewerModel: response.reviewerModel ?? response.defaultModel ?? "sonnet",
      defaultRuntime: runtime,
      executionTarget: target,
      modelProvider: provider,
      prProvider: prProvider,
      customInstructions: response.customInstructions,
      containerMemoryGb: response.containerMemoryGb,
      branchPrefix: response.branchPrefix ?? "autopod/",
      hasWebUi: response.hasWebUi ?? true,
      tokenBudget: response.tokenBudget,
      tokenBudgetPolicy: TokenBudgetPolicy(rawValue: response.tokenBudgetPolicy ?? "soft") ?? .soft,
      tokenBudgetWarnAt: response.tokenBudgetWarnAt ?? 0.8,
      maxBudgetExtensions: response.maxBudgetExtensions,
      issueWatcherEnabled: response.issueWatcherEnabled ?? false,
      issueWatcherLabelPrefix: response.issueWatcherLabelPrefix ?? "autopod",
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
        InjectedSkill(name: $0.name ?? "", description: $0.description, source: $0.source)
      },
      escalationAskHuman: escalation.askHuman,
      escalationAskAiEnabled: escalation.askAi.enabled,
      escalationAskAiModel: escalation.askAi.model,
      escalationAskAiMaxCalls: escalation.askAi.maxCalls,
      escalationAdvisorEnabled: escalation.advisor?.enabled ?? false,
      escalationAutoPauseAfter: escalation.autoPauseAfter,
      escalationHumanResponseTimeout: escalation.humanResponseTimeout,
      pod: {
        if let p = response.pod {
          let agent = AgentMode(rawValue: p.agentMode) ?? .auto
          let output = OutputTarget(rawValue: p.output) ?? .pr
          return PodConfig(agentMode: agent, output: output, validate: p.validate, promotable: p.promotable)
        }
        return PodConfig.fromLegacy(response.outputMode ?? "pr")
      }(),
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
      pimActivations: (response.pimActivations ?? []).compactMap { r in
        guard let type = PimActivationType(rawValue: r.type) else { return nil }
        return PimActivationEntry(
          type: type,
          groupId: r.groupId ?? "",
          scope: r.scope ?? "",
          roleDefinitionId: r.roleDefinitionId ?? "",
          displayName: r.displayName,
          duration: r.duration,
          justification: r.justification
        )
      },
      trustedSource: response.trustedSource ?? false,
      sidecars: response.sidecars.flatMap { s -> SidecarsSnapshot? in
        guard let d = s.dagger else { return SidecarsSnapshot(dagger: nil) }
        return SidecarsSnapshot(
          dagger: DaggerSidecarSnapshot(
            enabled: d.enabled,
            engineImageDigest: d.engineImageDigest,
            engineVersion: d.engineVersion,
            enginePort: d.enginePort,
            memoryGb: d.memoryGb,
            cpus: d.cpus,
            storageGb: d.storageGb
          )
        )
      },
      testPipeline: response.testPipeline.map(mapTestPipeline),
      securityScan: response.securityScan.map(mapSecurityScan),
      codeIntelligenceSerena: response.codeIntelligence?.serena ?? false,
      codeIntelligenceRoslynCodeLens: response.codeIntelligence?.roslynCodeLens ?? false,
      deploymentEnabled: response.deployment?.enabled ?? false,
      deploymentEnv: response.deployment?.env ?? [:],
      deploymentAllowedScripts: response.deployment?.allowedScripts ?? [],
      providerCredentialsType: response.providerCredentials?.provider,
      version: response.version,
      createdAt: PodMapper.parseDate(response.createdAt),
      updatedAt: PodMapper.parseDate(response.updatedAt)
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
      "reviewerModel": profile.reviewerModel,
      "defaultRuntime": profile.defaultRuntime.rawValue,
      "executionTarget": profile.executionTarget.rawValue,
      "modelProvider": profile.modelProvider.rawValue,
      "buildTimeout": profile.buildTimeout,
      "testTimeout": profile.testTimeout,
      "prProvider": profile.prProvider.rawValue,
      "outputMode": profile.pod.legacyOutputMode.rawValue,
      "pod": [
        "agentMode": profile.pod.agentMode.rawValue,
        "output": profile.pod.output.rawValue,
        "validate": profile.pod.validate,
        "promotable": profile.pod.promotable,
      ] as [String: Any],
      "smokePages": profile.smokePages.map { ["path": $0.path] },
      "privateRegistries": profile.privateRegistries.map {
        var r: [String: Any] = ["type": $0.type.rawValue, "url": $0.url]
        if let scope = $0.scope { r["scope"] = scope }
        return r
      },
      "allowedHosts": profile.allowedHosts,
      "mcpServers": profile.mcpServers.map { s -> [String: Any] in
        var r: [String: Any] = ["name": s.name, "url": s.url]
        if let d = s.description, !d.isEmpty { r["description"] = d }
        return r
      },
      "claudeMdSections": profile.claudeMdSections.map {
        ["heading": $0.heading, "content": $0.content]
      },
      "skills": profile.skills.map { s -> [String: Any] in
        // Daemon's InjectedSkill schema requires `source`. Pass through the
        // user-configured source dict; fall back to a local default keyed on
        // name if the editor left it unset or blank so the patch validates —
        // resolution at pod-run time still requires the file to exist on the
        // daemon host.
        var r: [String: Any] = ["name": s.name]
        var src = s.source ?? [:]
        if (src["type"] ?? "local") == "local" && (src["path"]?.isEmpty ?? true) {
          src = ["type": "local", "path": "\(s.name).md"]
        }
        if src["type"] == nil { src["type"] = "local" }
        r["source"] = src
        if let d = s.description, !d.isEmpty { r["description"] = d }
        return r
      },
    ]

    // Issue watcher
    d["issueWatcherEnabled"] = profile.issueWatcherEnabled
    d["issueWatcherLabelPrefix"] = profile.issueWatcherLabelPrefix

    // Branch & web UI
    d["branchPrefix"] = profile.branchPrefix
    d["hasWebUi"] = profile.hasWebUi

    // Token budget
    if let budget = profile.tokenBudget {
      d["tokenBudget"] = budget
      d["tokenBudgetPolicy"] = profile.tokenBudgetPolicy.rawValue
      d["tokenBudgetWarnAt"] = profile.tokenBudgetWarnAt
      if let ext = profile.maxBudgetExtensions { d["maxBudgetExtensions"] = ext }
    } else {
      d["tokenBudget"] = NSNull()
    }

    // Optional fields — only include if set
    if let v = profile.customInstructions { d["customInstructions"] = v }
    if let v = profile.testCommand { d["testCommand"] = v }
    if profile.buildEnv.isEmpty {
      d["buildEnv"] = NSNull()
    } else {
      d["buildEnv"] = profile.buildEnv
    }
    if let v = profile.buildWorkDir, !v.isEmpty {
      d["buildWorkDir"] = v
    } else {
      d["buildWorkDir"] = NSNull()
    }
    if let v = profile.lintCommand, !v.isEmpty {
      d["lintCommand"] = v
      if let t = profile.lintTimeout { d["lintTimeout"] = t }
    } else {
      d["lintCommand"] = NSNull()
    }
    if let v = profile.sastCommand, !v.isEmpty {
      d["sastCommand"] = v
      if let t = profile.sastTimeout { d["sastTimeout"] = t }
    } else {
      d["sastCommand"] = NSNull()
    }
    if let v = profile.mergePollIntervalSec { d["mergePollIntervalSec"] = v }
    else { d["mergePollIntervalSec"] = NSNull() }
    if let v = profile.fixPodCooldownSec { d["fixPodCooldownSec"] = v }
    else { d["fixPodCooldownSec"] = NSNull() }
    d["reuseFixPod"] = profile.reuseFixPod
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
      "advisor": [
        "enabled": profile.escalationAdvisorEnabled,
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

    // PIM activations
    if !profile.pimActivations.isEmpty {
      d["pimActivations"] = profile.pimActivations.map { e -> [String: Any] in
        var entry: [String: Any] = ["type": e.type.rawValue]
        switch e.type {
        case .group:
          entry["groupId"] = e.groupId
        case .rbacRole:
          entry["scope"] = e.scope
          entry["roleDefinitionId"] = e.roleDefinitionId
        }
        if let v = e.displayName, !v.isEmpty { entry["displayName"] = v }
        if let v = e.duration, !v.isEmpty { entry["duration"] = v }
        if let v = e.justification, !v.isEmpty { entry["justification"] = v }
        return entry
      }
    } else {
      d["pimActivations"] = NSNull()
    }

    // Sandbox & test pipeline
    d["trustedSource"] = profile.trustedSource
    if let t = profile.testPipeline {
      var tp: [String: Any] = [
        "enabled": t.enabled,
        "testRepo": t.testRepo,
        "testPipelineId": t.testPipelineId,
      ]
      if let r = t.rateLimitPerHour { tp["rateLimitPerHour"] = r }
      if let b = t.branchPrefix, !b.isEmpty { tp["branchPrefix"] = b }
      d["testPipeline"] = tp
    } else {
      d["testPipeline"] = NSNull()
    }
    // Security scan policy
    if let s = profile.securityScan {
      var detectors: [String: Any] = [
        "secrets": ["enabled": s.secretsDetector.enabled] as [String: Any],
      ]
      var pii: [String: Any] = ["enabled": s.piiDetector.enabled]
      if let t = s.piiDetector.threshold { pii["threshold"] = t }
      detectors["pii"] = pii
      var injection: [String: Any] = ["enabled": s.injectionDetector.enabled]
      if let t = s.injectionDetector.threshold { injection["threshold"] = t }
      detectors["injection"] = injection

      func checkpointDict(_ c: CheckpointPolicy) -> [String: Any] {
        return [
          "enabled": c.enabled,
          "scope": c.scope.rawValue,
          "onSecret": c.onSecret.rawValue,
          "onPii": c.onPii.rawValue,
          "onInjection": c.onInjection.rawValue,
        ]
      }
      var scan: [String: Any] = [
        "detectors": detectors,
        "provisioning": checkpointDict(s.provisioning),
        "push": checkpointDict(s.push),
      ]
      if !s.alwaysScanPaths.isEmpty {
        scan["alwaysScanPaths"] = s.alwaysScanPaths
      }
      d["securityScan"] = scan
    } else {
      d["securityScan"] = NSNull()
    }

    // Sidecars: preserved verbatim so write operations don't wipe fields the
    // editor doesn't surface yet (dagger engine digest/version/etc.).
    if let s = profile.sidecars {
      var sidecars: [String: Any] = [:]
      if let d2 = s.dagger {
        var dag: [String: Any] = [
          "enabled": d2.enabled,
          "engineImageDigest": d2.engineImageDigest,
          "engineVersion": d2.engineVersion,
        ]
        if let v = d2.enginePort { dag["enginePort"] = v }
        if let v = d2.memoryGb { dag["memoryGb"] = v }
        if let v = d2.cpus { dag["cpus"] = v }
        if let v = d2.storageGb { dag["storageGb"] = v }
        sidecars["dagger"] = dag
      }
      d["sidecars"] = sidecars
    } else {
      d["sidecars"] = NSNull()
    }

    // Code intelligence
    if profile.codeIntelligenceSerena || profile.codeIntelligenceRoslynCodeLens {
      var ci: [String: Any] = [:]
      if profile.codeIntelligenceSerena { ci["serena"] = true }
      if profile.codeIntelligenceRoslynCodeLens { ci["roslynCodeLens"] = true }
      d["codeIntelligence"] = ci
    } else {
      d["codeIntelligence"] = NSNull()
    }

    // Deployment — preserve `$DAEMON:` value prefixes verbatim. Treat the
    // (disabled, no env, no scripts) tuple as "clear" so derived profiles
    // can reset back to inheriting from the parent.
    if profile.deploymentEnabled
      || !profile.deploymentEnv.isEmpty
      || !profile.deploymentAllowedScripts.isEmpty {
      var dep: [String: Any] = [
        "enabled": profile.deploymentEnabled,
        "env": profile.deploymentEnv,
      ]
      if !profile.deploymentAllowedScripts.isEmpty {
        dep["allowedScripts"] = profile.deploymentAllowedScripts
      }
      d["deployment"] = dep
    } else {
      d["deployment"] = NSNull()
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

  // MARK: - Helpers for type-checker performance

  fileprivate static func mapTestPipeline(_ t: TestPipelineResponse) -> TestPipelineConfig {
    TestPipelineConfig(
      enabled: t.enabled,
      testRepo: t.testRepo,
      testPipelineId: t.testPipelineId,
      rateLimitPerHour: t.rateLimitPerHour,
      branchPrefix: t.branchPrefix
    )
  }

  fileprivate static func mapSecurityScan(_ s: SecurityScanPolicyResponse) -> SecurityScanPolicy {
    SecurityScanPolicy(
      secretsDetector: DetectorConfig(
        enabled: s.detectors.secrets.enabled,
        threshold: s.detectors.secrets.threshold
      ),
      piiDetector: DetectorConfig(
        enabled: s.detectors.pii.enabled,
        threshold: s.detectors.pii.threshold
      ),
      injectionDetector: DetectorConfig(
        enabled: s.detectors.injection.enabled,
        threshold: s.detectors.injection.threshold
      ),
      provisioning: mapCheckpoint(s.provisioning),
      push: mapCheckpoint(s.push),
      alwaysScanPaths: s.alwaysScanPaths ?? []
    )
  }

  fileprivate static func mapCheckpoint(_ c: CheckpointPolicyResponse) -> CheckpointPolicy {
    CheckpointPolicy(
      enabled: c.enabled,
      scope: ScanScope(rawValue: c.scope) ?? .auto,
      onSecret: ScanOutcome(rawValue: c.onSecret) ?? .block,
      onPii: ScanOutcome(rawValue: c.onPii) ?? .warn,
      onInjection: ScanOutcome(rawValue: c.onInjection) ?? .warn
    )
  }
}
