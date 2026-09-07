import Foundation

public struct ExecutionProvenanceResponse: Codable, Sendable { public let latest: ExecutionProvenance? }
public struct ExecutionProvenance: Codable, Sendable {
  public let executionId: String
  public let generation: Int
  public let checkedAt: String
  public let status: String
  public let runtime: String
  public let model: String
  public let cliVersion: String?
  public let imageDigest: String?
  public let contractHash: String
  public let validationImplementationHash: String?
  public let release: DaemonReleaseSnapshot
  public let capabilities: ExecutionCapabilities
  public let commands: ExecutionCommandPreflight
  public let diagnostics: [ExecutionDiagnostic]
}
public struct ExecutionCapabilities: Codable, Sendable {
  public let streamingExec: String
  public let memoryLimitBytes: Int?
  public let cpuLimit: Double?
  public let networkMode: String?
}
public struct ExecutionCommandPreflight: Codable, Sendable {
  public let requirements: [ExecutionCommandRequirement]
  public let unresolvedSources: [String]
  public let deferredArtifacts: [String]
  public let explicitDependencies: Bool
}
public struct ExecutionCommandRequirement: Codable, Sendable {
  public let source: String
  public let executable: String
  public let available: Bool?
}
public struct ExecutionDiagnostic: Codable, Sendable {
  public let code: String
  public let detail: String
}
