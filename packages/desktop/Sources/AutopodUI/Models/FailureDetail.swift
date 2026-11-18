import Foundation

/// Nil detail means pending/unavailable; a full detail with nil reason confirms absence.
public struct FailureDetail: Equatable, Sendable {
    public let podID: String
    public let updatedAt: Date
    public let status: PodStatus
    public let reason: String?
    public let validationTitle: String?

    public init(podID: String, updatedAt: Date, status: PodStatus, reason: String?, validationTitle: String? = nil) {
        self.podID = podID
        self.updatedAt = updatedAt
        self.status = status
        self.reason = reason
        self.validationTitle = validationTitle
    }

    public func isCurrent(for pod: Pod) -> Bool {
        podID == pod.id && updatedAt == pod.updatedAt && status == pod.status
    }
}

extension Pod {
    public var failureWarningTitle: String? {
        if needsExecutionInspection { return "Execution requires recovery inspection" }
        if worktreeCompromised { return "Worktree needs recovery" }
        if isFixDeliveryFailure { return "Fix validated, push failed" }
        return nil
    }

    public var currentFailureDetail: FailureDetail? {
        failureDetail.flatMap { $0.isCurrent(for: self) ? $0 : nil }
    }

    public var recordedFailureReason: String? { currentFailureDetail?.reason }

    public var failureOverviewTitle: String? {
        guard status == .failed || status == .reviewRequired else { return nil }
        guard let detail = currentFailureDetail else { return nil }
        // Known lifecycle causes take precedence over a retained validation result.
        if let reason = detail.reason {
            for (prefix, title) in [("Agent failed:", "Agent failed"), ("Provisioning failed:", "Provisioning failed"), ("Revalidation failed —", "Revalidation failed")] {
                if reason.hasPrefix(prefix) { return title }
            }
        }
        return detail.validationTitle
    }
}
