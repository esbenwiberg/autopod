import AutopodClient
import Foundation

public enum SandboxRecoveryControlPolicy {
  public static func canStart(_ resource: SandboxRecoveryResource, reason: String, busy: Bool) -> Bool {
    !busy && resource.startBlocked == nil && resource.abandonment == nil &&
      resource.providerState == "stopped" && resource.pendingIntentIds.isEmpty &&
      reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 10
  }

  public static func canAbandon(_ resource: SandboxRecoveryResource, currentUserId: String?,
                                reason: String, acceptsLoss: Bool, busy: Bool) -> Bool {
    guard !busy, acceptsLoss, resource.abandonBlocked == nil else { return false }
    if let decision = resource.abandonment, decision.userId == currentUserId { return true }
    return reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 10
  }
}
