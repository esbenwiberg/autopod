import Foundation

public struct ExecutionProvenanceResponse: Codable, Sendable { public let latest: ExecutionProvenance? }
public struct ExecutionProvenance: Codable, Sendable {
  public let executionId: String
  public let generation: Int
  public let checkedAt: String
  public let purpose: String?
  public let subject: String?
  public var subjectLabel: String { subject == "reviewer" ? "Reviewer" : "Configured worker" }
  public let status: String
  public let version: Int?
  public let surface: String?
  public let dispatchModel: String?
  public var runtimeLabel: String { surface == "provider-api" ? "Provider API · dispatch model \(dispatchModel ?? "unverified")" : "\(runtime ?? "unverified") CLI \(cliVersion ?? "unverified")" }
  public var imageLabel: String { surface == "provider-api" ? "not applicable" : (imageDigest ?? "unverified") }
  public let runtime: String?
  public let model: String
  public let providerId: String?
  public let providerAccountId: String?
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
