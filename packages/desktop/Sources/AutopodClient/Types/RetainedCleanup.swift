import CryptoKit
import Foundation

public struct RetainedCleanupRequest: Codable, Sendable, Equatable {
  public let id: String
  public let expectedGeneration: Int
  public let expectedBinding: String
  public let expectedSessionId: String
  public let reason: String
  public let acknowledgeDataLoss: Bool

  public init(id: String, plan: RetainedCleanupPlan, reason: String) {
    self.id = id
    expectedGeneration = plan.generation
    expectedBinding = plan.binding
    expectedSessionId = plan.sessionId
    self.reason = Self.normalizedReason(reason)
    acknowledgeDataLoss = true
  }

  // Match JavaScript String.trim(), including BOM but not Unicode NEL.
  public static func normalizedReason(_ reason: String) -> String {
    reason.trimmingCharacters(in: CharacterSet(charactersIn:
      "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"))
  }

  public var valid: Bool {
    Self.validId(id) && expectedGeneration > 0 && expectedGeneration <= 9_007_199_254_740_991
      && cleanupPattern(expectedBinding, "^[a-f0-9]{64}$")
      && (1...128).contains(expectedSessionId.utf16.count)
      && reason == Self.normalizedReason(reason) && (10...4000).contains(reason.utf16.count)
      && acknowledgeDataLoss
  }

  public static func validId(_ id: String) -> Bool { cleanupPattern(id, "^[A-Za-z0-9-]{1,64}$") }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.id == rhs.id && lhs.expectedGeneration == rhs.expectedGeneration
      && lhs.expectedBinding == rhs.expectedBinding
      && lhs.expectedSessionId.utf8.elementsEqual(rhs.expectedSessionId.utf8)
      && lhs.reason.utf8.elementsEqual(rhs.reason.utf8)
      && lhs.acknowledgeDataLoss == rhs.acknowledgeDataLoss
  }
}

private func cleanupPattern(_ value: String, _ pattern: String) -> Bool {
  value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
}

public struct RetainedCleanupBlocker: Codable, Sendable {
  public let code: String
  public let message: String
  public let resourceId: String?
  var valid: Bool { !code.isEmpty && !message.isEmpty && resourceId != "" }
}

public struct RetainedCleanupResource: Codable, Sendable, Hashable {
  public enum Kind: String, Codable, Sendable {
    case dockerContainer = "docker_container", dockerBridge = "docker_bridge"
    case hostWorktree = "host_worktree", hostPreparedRoot = "host_prepared_root"
  }
  public enum Role: String, Codable, Sendable {
    case guestExecution = "guest_execution", ownedBridge = "owned_bridge"
    case originalCheckout = "original_checkout", preparedCheckout = "prepared_checkout"
    case privatePreparedSource = "private_prepared_source"

    public var label: String {
      switch self {
      case .guestExecution: "Guest execution"
      case .ownedBridge: "Owned Docker bridge"
      case .originalCheckout: "Original Git checkout"
      case .preparedCheckout: "Prepared Git checkout"
      case .privatePreparedSource: "Private prepared source"
      }
    }
  }
  public let kind: Kind
  public let role: Role
  public let id: String
  public let namespace: String

  var valid: Bool {
    guard !id.isEmpty, !namespace.isEmpty else { return false }
    switch (kind, role) {
    case (.dockerContainer, .guestExecution), (.dockerBridge, .ownedBridge):
      return cleanupPattern(id, "^[a-f0-9]{64}$")
    case (.hostWorktree, .originalCheckout), (.hostWorktree, .preparedCheckout),
         (.hostPreparedRoot, .privatePreparedSource):
      return id.hasPrefix("/")
    default: return false
    }
  }
}

public struct RetainedCleanupPlan: Codable, Sendable {
  public let version: Int
  public let generation: Int
  public let binding: String
  public let sessionId: String
  public let resources: [RetainedCleanupResource]
  public let dataLoss: [String]
  public let retained: [String]
  public let notReclaimed: [String]

  var valid: Bool {
    version == 1 && generation > 0 && generation <= 9_007_199_254_740_991
      && cleanupPattern(binding, "^[a-f0-9]{64}$") && (1...128).contains(sessionId.utf16.count)
      && !resources.isEmpty && resources.allSatisfy(\.valid)
      && Set(resources.map { [$0.kind.rawValue, $0.namespace, $0.id] }).count == resources.count
      && [dataLoss, retained, notReclaimed].allSatisfy { !$0.isEmpty && $0.allSatisfy { !$0.isEmpty } }
  }

  /// Client-side fingerprint of the entire reviewed display, including ordered targets.
  public func fingerprint() throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return SHA256.hash(data: try encoder.encode(self)).map { String(format: "%02x", $0) }.joined()
  }
}

public struct RetainedCleanupInspection: Decodable, Sendable {
  public enum State: String, Decodable, Sendable { case eligible, blocked, requested }
  public let state: State
  public let podId: String
  public let plan: RetainedCleanupPlan?
  public let blockers: [RetainedCleanupBlocker]?
  public let requestId: String?

  public func validate(podId expected: String) throws {
    guard podId == expected else { throw RetainedCleanupError.invalidReply }
    switch state {
    case .eligible:
      guard plan?.valid == true, blockers == nil, requestId == nil else { throw RetainedCleanupError.invalidReply }
    case .blocked:
      guard plan == nil, requestId == nil, let blockers, !blockers.isEmpty, blockers.allSatisfy(\.valid)
      else { throw RetainedCleanupError.invalidReply }
    case .requested:
      guard plan == nil, blockers == nil, let requestId, RetainedCleanupRequest.validId(requestId)
      else { throw RetainedCleanupError.invalidReply }
    }
  }
}

public struct RetainedCleanupReceipt: Decodable, Sendable {
  public enum State: String, Decodable, Sendable { case pending, partial, deleted }
  public struct Actor: Decodable, Sendable {
    public let type: String
    public let userId: String
  }
  public struct Progress: Decodable, Sendable {
    public enum State: String, Decodable, Sendable {
      case pending, removalUnconfirmed = "removal_unconfirmed", confirmedAbsent = "confirmed_absent"

      public var label: String {
        switch self {
        case .pending: "Still held — pending"
        case .removalUnconfirmed: "Removal sent — absence unconfirmed"
        case .confirmedAbsent: "Confirmed absent"
        }
      }
    }
    public let target: RetainedCleanupResource
    public let state: State

    private enum CodingKeys: String, CodingKey { case state }
    public init(from decoder: Decoder) throws {
      target = try RetainedCleanupResource(from: decoder)
      state = try decoder.container(keyedBy: CodingKeys.self).decode(State.self, forKey: .state)
    }
  }

  public let podId: String
  public let request: RetainedCleanupRequest
  public let actor: Actor
  public let plan: RetainedCleanupPlan
  public let createdAt: String
  public let updatedAt: String
  public let state: State
  public let resources: [Progress]
  public let blockers: [RetainedCleanupBlocker]

  public func validate(podId expectedPod: String, requestId: String,
                       expectedRequest: RetainedCleanupRequest? = nil, expectedPlan: String? = nil) throws {
    guard podId == expectedPod, request.id == requestId, request.valid,
      expectedRequest == nil || expectedRequest == request,
      actor.type == "human", !actor.userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      Self.validDate(createdAt), Self.validDate(updatedAt),
      plan.valid, plan.generation == request.expectedGeneration, plan.binding == request.expectedBinding,
      plan.sessionId.utf8.elementsEqual(request.expectedSessionId.utf8),
      try expectedPlan == nil || expectedPlan == plan.fingerprint(),
      resources.count == plan.resources.count, zip(resources, plan.resources).allSatisfy({
        $0.target.kind == $1.kind && $0.target.role == $1.role
          && $0.target.id.utf8.elementsEqual($1.id.utf8)
          && $0.target.namespace.utf8.elementsEqual($1.namespace.utf8)
      }), blockers.allSatisfy(\.valid),
      state != .deleted || (blockers.isEmpty && resources.allSatisfy { $0.state == .confirmedAbsent }),
      state != .pending || (blockers.isEmpty && resources.allSatisfy { $0.state == .pending })
    else { throw RetainedCleanupError.invalidReply }
  }

  private static func validDate(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil
  }
}

public enum RetainedCleanupSubmission: Decodable, Sendable {
  case blocked(RetainedCleanupInspection)
  case receipt(RetainedCleanupReceipt)

  private enum CodingKeys: String, CodingKey { case state }
  public init(from decoder: Decoder) throws {
    let state = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .state)
    self = if state == "blocked" {
      .blocked(try RetainedCleanupInspection(from: decoder))
    } else {
      .receipt(try RetainedCleanupReceipt(from: decoder))
    }
  }
}

public enum RetainedCleanupError: LocalizedError {
  case unsupported, notFound, invalidReply

  public var errorDescription: String? {
    switch self {
    case .unsupported: "This daemon does not expose retained cleanup. Do not use Kill or ordinary Delete as a fallback."
    case .notFound: "No record was found for the exact pod or request. This is not proof of deletion or failure."
    case .invalidReply: "The reply did not prove the exact cleanup selection and outcome."
    }
  }
}
