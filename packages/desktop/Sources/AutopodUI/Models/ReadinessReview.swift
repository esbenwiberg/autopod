import Foundation
import SwiftUI

public enum ReadinessStatus: String, Sendable, CaseIterable {
    case ready
    case needsReview = "needs_review"
    case risky
    case waived
    case notAvailable = "not_available"
    case notApplicable = "not_applicable"

    public var label: String {
        switch self {
        case .needsReview: "needs_review"
        case .notAvailable: "not_available"
        case .notApplicable: "not_applicable"
        default: rawValue
        }
    }

    public var displayLabel: String {
        switch self {
        case .needsReview: "needs review"
        case .notAvailable: "not available"
        case .notApplicable: "not applicable"
        default: rawValue
        }
    }

    public var color: Color {
        switch self {
        case .ready: .green
        case .needsReview: .orange
        case .risky: .red
        case .waived: .orange
        case .notAvailable: .secondary
        case .notApplicable: .secondary
        }
    }

    public var requiresApprovalReason: Bool {
        self == .risky || self == .waived
    }

    public var canApproveFromHeader: Bool {
        self == .ready
    }

    public var isGreen: Bool {
        self == .ready || self == .notApplicable
    }
}

public enum ReadinessArea: String, Sendable, CaseIterable {
    case validation
    case security
    case actions
    case network
    case scope
    case quality
    case advisoryQa = "advisory_qa"
    case pr

    public var label: String {
        switch self {
        case .advisoryQa: "Advisory QA"
        case .pr: "PR"
        default: rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

public enum ReadinessSeverity: String, Sendable {
    case info
    case warning
    case error

    public var color: Color {
        switch self {
        case .info: .secondary
        case .warning: .orange
        case .error: .red
        }
    }
}

public enum ReadinessSourceKind: String, Sendable {
    case validation
    case work
    case logs
    case diff
    case pr
    case evidence
    case quality
    case event
}

public struct ReadinessSourceRef: Identifiable, Sendable, Hashable {
    public var id: String { "\(kind.rawValue):\(label):\(anchor ?? ""):\(href?.absoluteString ?? "")" }
    public let kind: ReadinessSourceKind
    public let label: String
    public let anchor: String?
    public let href: URL?

    public init(kind: ReadinessSourceKind, label: String, anchor: String? = nil, href: URL? = nil) {
        self.kind = kind
        self.label = label
        self.anchor = anchor
        self.href = href
    }

    public var detailTab: DetailTab? {
        switch kind {
        case .validation: .validation
        case .work, .quality: .work
        case .logs, .event: .logs
        case .diff: .diff
        case .evidence: .evidence
        case .pr: nil
        }
    }
}

public struct ReadinessAreaReview: Identifiable, Sendable, Hashable {
    public var id: ReadinessArea { area }
    public let area: ReadinessArea
    public let status: ReadinessStatus
    public let title: String
    public let summary: String
    public let sourceRefs: [ReadinessSourceRef]

    public init(
        area: ReadinessArea,
        status: ReadinessStatus,
        title: String,
        summary: String,
        sourceRefs: [ReadinessSourceRef]
    ) {
        self.area = area
        self.status = status
        self.title = title
        self.summary = summary
        self.sourceRefs = sourceRefs
    }
}

public struct ReadinessFinding: Identifiable, Sendable, Hashable {
    public let id: String
    public let area: ReadinessArea
    public let severity: ReadinessSeverity
    public let title: String
    public let detail: String
    public let sourceRefs: [ReadinessSourceRef]

    public init(
        id: String,
        area: ReadinessArea,
        severity: ReadinessSeverity,
        title: String,
        detail: String,
        sourceRefs: [ReadinessSourceRef]
    ) {
        self.id = id
        self.area = area
        self.severity = severity
        self.title = title
        self.detail = detail
        self.sourceRefs = sourceRefs
    }
}

public struct ReadinessApproval: Sendable, Hashable {
    public let approvedAt: Date
    public let approvedBy: String?
    public let statusAtApproval: ReadinessStatus
    public let scope: ReadinessScope
    public let seriesId: String?
    public let reason: String?

    public init(
        approvedAt: Date,
        approvedBy: String?,
        statusAtApproval: ReadinessStatus,
        scope: ReadinessScope,
        seriesId: String? = nil,
        reason: String? = nil
    ) {
        self.approvedAt = approvedAt
        self.approvedBy = approvedBy
        self.statusAtApproval = statusAtApproval
        self.scope = scope
        self.seriesId = seriesId
        self.reason = reason
    }
}

public enum ReadinessScope: String, Sendable, Hashable {
    case pod
    case series
}

public struct ReadinessReview: Sendable, Hashable {
    public let status: ReadinessStatus
    public let summary: String
    public let computedAt: Date
    public let scope: ReadinessScope
    public let areas: [ReadinessAreaReview]
    public let findings: [ReadinessFinding]
    public let approval: ReadinessApproval?

    public init(
        status: ReadinessStatus,
        summary: String,
        computedAt: Date,
        scope: ReadinessScope = .pod,
        areas: [ReadinessAreaReview],
        findings: [ReadinessFinding],
        approval: ReadinessApproval? = nil
    ) {
        self.status = status
        self.summary = summary
        self.computedAt = computedAt
        self.scope = scope
        self.areas = areas
        self.findings = findings
        self.approval = approval
    }
}

public struct SeriesMemberReadiness: Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let status: ReadinessStatus
    public let summary: String

    public init(id: String, title: String, status: ReadinessStatus, summary: String) {
        self.id = id
        self.title = title
        self.status = status
        self.summary = summary
    }
}

public struct SeriesReadinessReview: Sendable, Hashable {
    public let status: ReadinessStatus
    public let summary: String
    public let computedAt: Date
    public let seriesId: String
    public let branch: String
    public let areas: [ReadinessAreaReview]
    public let findings: [ReadinessFinding]
    public let members: [SeriesMemberReadiness]

    public init(
        status: ReadinessStatus,
        summary: String,
        computedAt: Date,
        seriesId: String,
        branch: String,
        areas: [ReadinessAreaReview],
        findings: [ReadinessFinding],
        members: [SeriesMemberReadiness]
    ) {
        self.status = status
        self.summary = summary
        self.computedAt = computedAt
        self.seriesId = seriesId
        self.branch = branch
        self.areas = areas
        self.findings = findings
        self.members = members
    }
}

public extension SeriesReadinessReview {
    static func rollup(for owner: Pod, seriesPods inputPods: [Pod]) -> SeriesReadinessReview? {
        guard owner.isSeriesReadinessOwner else { return nil }
        let pods = inputPods.isEmpty ? [owner] : inputPods
        guard let seriesId = owner.seriesId, pods.count > 1 else { return nil }

        let orderedPods = pods.sorted { lhs, rhs in
            if lhs.id == owner.id { return false }
            if rhs.id == owner.id { return true }
            return lhs.startedAt < rhs.startedAt
        }
        let computedAt = orderedPods.compactMap(\.readinessReview?.computedAt).max() ?? Date()
        let members = orderedPods.map { pod in
            SeriesMemberReadiness(
                id: pod.id,
                title: pod.briefTitle ?? pod.id,
                status: pod.readinessReview?.status ?? .notAvailable,
                summary: pod.readinessReview?.summary ?? "Readiness unavailable."
            )
        }
        let memberFindings = orderedPods.flatMap { pod in
            pod.readinessReview?.findings.map { finding in
                ReadinessFinding(
                    id: "series:\(seriesId):\(pod.id):\(finding.id)",
                    area: finding.area,
                    severity: finding.severity,
                    title: "\(pod.id): \(finding.title)",
                    detail: finding.detail,
                    sourceRefs: finding.sourceRefs
                )
            } ?? [
                ReadinessFinding(
                    id: "series:\(seriesId):missing:\(pod.id)",
                    area: .quality,
                    severity: .warning,
                    title: "\(pod.id): Member readiness unavailable",
                    detail: "Pod \(pod.id) has no Readiness Review snapshot.",
                    sourceRefs: [ReadinessSourceRef(kind: .work, label: "Work")]
                ),
            ]
        }
        let status = worstStatus(memberStatuses: members.map(\.status), findings: memberFindings)
        let affectedPods = Set(memberFindings.compactMap { finding -> String? in
            let pieces = finding.id.split(separator: ":")
            guard pieces.count > 2 else { return nil }
            return String(pieces[2])
        })
        let summary = memberFindings.isEmpty
            ? "\(members.count) member pod(s) are ready."
            : "\(memberFindings.count) finding(s) across \(affectedPods.count) of \(members.count) pod(s)."
        let areas = rollupAreas(from: orderedPods, status: status, findings: memberFindings)
        return SeriesReadinessReview(
            status: status,
            summary: summary,
            computedAt: computedAt,
            seriesId: seriesId,
            branch: owner.branch,
            areas: areas,
            findings: memberFindings,
            members: members
        )
    }

    private static func worstStatus(
        memberStatuses: [ReadinessStatus],
        findings: [ReadinessFinding]
    ) -> ReadinessStatus {
        if memberStatuses.contains(.risky) || findings.contains(where: { $0.severity == .error }) {
            return .risky
        }
        if memberStatuses.contains(.waived) { return .waived }
        if memberStatuses.contains(.needsReview) || memberStatuses.contains(.notAvailable) || !findings.isEmpty {
            return .needsReview
        }
        return .ready
    }

    private static func rollupAreas(
        from pods: [Pod],
        status: ReadinessStatus,
        findings: [ReadinessFinding]
    ) -> [ReadinessAreaReview] {
        ReadinessArea.allCases.map { area in
            let areaFindings = findings.filter { $0.area == area }
            let memberStatuses = pods.compactMap { pod in
                pod.readinessReview?.areas.first(where: { $0.area == area })?.status
            }
            let areaStatus = areaFindings.isEmpty ? worstAreaStatus(memberStatuses) : statusForFindings(areaFindings)
            let summary = areaFindings.first?.title
                ?? pods.compactMap { $0.readinessReview?.areas.first(where: { $0.area == area })?.summary }.first
                ?? "No member findings."
            return ReadinessAreaReview(
                area: area,
                status: areaStatus,
                title: area.label,
                summary: summary,
                sourceRefs: areaFindings.first?.sourceRefs ?? [ReadinessSourceRef(kind: .work, label: "Work")]
            )
        }
    }

    private static func worstAreaStatus(_ statuses: [ReadinessStatus]) -> ReadinessStatus {
        if statuses.contains(.risky) { return .risky }
        if statuses.contains(.waived) { return .waived }
        if statuses.contains(.needsReview) { return .needsReview }
        if statuses.contains(.notAvailable) { return .notAvailable }
        if statuses.allSatisfy({ $0 == .notApplicable }) { return .notApplicable }
        return statuses.isEmpty ? .notAvailable : .ready
    }

    private static func statusForFindings(_ findings: [ReadinessFinding]) -> ReadinessStatus {
        if findings.contains(where: { $0.severity == .error }) { return .risky }
        return .needsReview
    }
}

public extension Pod {
    var isSeriesReadinessOwner: Bool {
        guard seriesId != nil, pod.output == .pr else { return false }
        return true
    }

    var readinessApprovalStatus: ReadinessStatus? {
        readinessReview?.status
    }
}
