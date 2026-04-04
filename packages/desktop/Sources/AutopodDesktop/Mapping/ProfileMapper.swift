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

  // MARK: - Profile → ProfileResponse

  public static func mapToResponse(_ profile: Profile) -> ProfileResponse {
    var r = ProfileResponse()
    r.name = profile.name
    r.repoUrl = profile.repoUrl
    r.defaultBranch = profile.defaultBranch
    r.template = profile.template.rawValue
    r.buildCommand = profile.buildCommand
    r.startCommand = profile.startCommand
    r.healthPath = profile.healthPath
    r.healthTimeout = profile.healthTimeout
    r.smokePages = profile.smokePages.map { .init(path: $0.path, assertions: nil) }
    r.maxValidationAttempts = profile.maxValidationAttempts
    r.defaultModel = profile.defaultModel
    r.defaultRuntime = profile.defaultRuntime.rawValue
    r.executionTarget = profile.executionTarget.rawValue
    r.customInstructions = profile.customInstructions
    r.outputMode = "pr"
    r.modelProvider = profile.modelProvider.rawValue
    r.testCommand = profile.testCommand
    r.buildTimeout = profile.buildTimeout
    r.testTimeout = profile.testTimeout
    r.prProvider = profile.prProvider.rawValue
    r.adoPat = profile.adoPat
    r.githubPat = profile.githubPat
    r.registryPat = profile.registryPat
    r.containerMemoryGb = profile.containerMemoryGb
    r.mcpServers = profile.mcpServers.map {
      InjectedMcpServerResponse(name: $0.name, url: $0.url, description: $0.description)
    }
    r.claudeMdSections = profile.claudeMdSections.map {
      InjectedClaudeMdSectionResponse(heading: $0.heading, content: $0.content, priority: nil)
    }
    r.skills = profile.skills.map {
      InjectedSkillResponse(name: $0.name, description: $0.description)
    }
    r.privateRegistries = profile.privateRegistries.map {
      PrivateRegistryResponse(type: $0.type.rawValue, url: $0.url, scope: $0.scope)
    }
    if profile.networkEnabled {
      r.networkPolicy = .init(enabled: true, mode: profile.networkMode.rawValue,
                              allowedHosts: profile.allowedHosts, replaceDefaults: nil)
    }
    return r
  }
}
