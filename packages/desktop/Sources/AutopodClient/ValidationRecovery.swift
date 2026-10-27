import Foundation

public struct ValidationRecoveryAvailability: Codable, Sendable, Equatable {
  public let allowed: Bool
  public let reason: String?
  public let code: String?

  public init(allowed: Bool, reason: String? = nil, code: String? = nil) {
    self.allowed = allowed
    self.reason = reason
    self.code = code
  }
}

public struct ValidationRecoveryError: Codable, Sendable, Equatable {
  public let code: String
  public let message: String
}

public struct ValidationRecoveryState: Codable, Sendable, Equatable {
  public let generation: Int
  public let validationTimestamp: String?
  public let fixValidation: ValidationRecoveryAvailability
  public let retryChecks: ValidationRecoveryAvailability
  public let activeAction: String?
  public let lastError: ValidationRecoveryError?

  public init(generation: Int, validationTimestamp: String?, fixValidation: ValidationRecoveryAvailability,
              retryChecks: ValidationRecoveryAvailability, activeAction: String? = nil,
              lastError: ValidationRecoveryError? = nil) {
    self.generation = generation
    self.validationTimestamp = validationTimestamp
    self.fixValidation = fixValidation
    self.retryChecks = retryChecks
    self.activeAction = activeAction
    self.lastError = lastError
  }
}

public struct ValidationRecoveryRequest: Codable, Sendable {
  public let action: String
  public let expectedGeneration: Int
  public let expectedValidationTimestamp: String

  public init(action: String, state: ValidationRecoveryState) throws {
    guard ["fix-validation", "retry-checks"].contains(action),
          let timestamp = state.validationTimestamp else {
      throw URLError(.badServerResponse)
    }
    self.action = action
    self.expectedGeneration = state.generation
    self.expectedValidationTimestamp = timestamp
  }
}
