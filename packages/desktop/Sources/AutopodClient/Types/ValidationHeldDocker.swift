import Foundation

public struct ValidationHeldDockerView: Decodable, Sendable {
  public let podId: String
  public let state: String
  public let generation: Int?
  public let binding: String?
  public let requestKey: String?
  public let resources: [RetainedCleanupResource]?
  public let observedStopped: Bool?
  public let blockers: [RetainedCleanupBlocker]
  public let message: String

  public func validate(podId: String, key: String? = nil) throws {
    guard self.podId == podId, key == nil || key == requestKey,
      ["eligible", "blocked", "pending", "unknown", "stopped"].contains(state), !message.isEmpty,
      blockers.allSatisfy(\.valid) else { throw RetainedCleanupError.invalidReply }
    if state == "blocked" {
      guard !blockers.isEmpty else { throw RetainedCleanupError.invalidReply }
    } else {
      guard let generation, generation > 0, let binding,
        binding.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
        let resources, !resources.isEmpty, resources.allSatisfy(\.valid),
        state == "eligible" || requestKey.map(RetainedCleanupRequest.validId) == true
      else { throw RetainedCleanupError.invalidReply }
    }
  }
}
