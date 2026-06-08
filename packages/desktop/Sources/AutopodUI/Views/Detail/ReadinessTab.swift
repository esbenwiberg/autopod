import AppKit
import AutopodClient
import SwiftUI

struct ReadinessTab: View {
    let pod: Pod
    let seriesReadiness: SeriesReadinessReview?
    var actions: PodActions = .preview
    var loadFirewallDenials: ((String, String?) async throws -> [FirewallDenialResponse])?
    var onOpenTab: (DetailTab) -> Void = { _ in }

    @State private var approvalReason = ""
    @State private var firewallDenials: [FirewallDenialResponse] = []
    @State private var firewallDenialsError: String?
    @State private var isLoadingFirewallDenials = false

    private var decisionStatus: ReadinessStatus? {
        seriesReadiness?.status ?? pod.readinessReview?.status
    }

    private var requiresReason: Bool {
        decisionStatus?.requiresApprovalReason ?? false
    }

    private var canApprove: Bool {
        guard let decisionStatus, decisionStatus.canApproveFromReadinessTab else { return false }
        return !requiresReason || !approvalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let seriesReadiness {
                    seriesSection(seriesReadiness)
                    if pod.readinessReview?.scope == .pod {
                        Divider()
                    }
                }

                if let readiness = pod.readinessReview, readiness.scope == .pod {
                    podSection(readiness)
                } else if seriesReadiness == nil {
                    pendingSection
                }

                approvalSection
            }
            .padding(20)
            .frame(maxWidth: 900, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func seriesSection(_ readiness: SeriesReadinessReview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            reviewHeader(
                title: "Series Readiness",
                status: readiness.status,
                summary: readiness.summary,
                computedAt: readiness.computedAt
            )

            HStack(spacing: 8) {
                Label("Single PR: \(readiness.branch)", systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }

            areaSection(title: "Overall areas", areas: readiness.areas, findings: readiness.findings)
            memberSection(readiness.members)
        }
        .readinessPanel()
    }

    private func podSection(_ readiness: ReadinessReview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            reviewHeader(
                title: "Readiness Review",
                status: readiness.status,
                summary: readiness.summary,
                computedAt: readiness.computedAt
            )
            areaSection(title: "Areas", areas: readiness.areas, findings: readiness.findings)
            findingsSection(readiness.findings)
            firewallDenialsSection(readiness)
        }
        .readinessPanel()
        .task(id: "\(pod.id)-\(readiness.computedAt.timeIntervalSince1970)") {
            await refreshFirewallDenials(for: readiness)
        }
    }

    private var pendingSection: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "hourglass")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text("Readiness pending")
                    .font(.callout.weight(.semibold))
                Text("Readiness Review is unavailable until validation or a terminal review state refreshes the snapshot.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .readinessPanel()
    }

    private func reviewHeader(
        title: String,
        status: ReadinessStatus,
        summary: String,
        computedAt: Date
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.title3.weight(.semibold))
                Text("\(status.label) - \(summary)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Computed \(computedAt.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            readinessStatusPill(status)
        }
    }

    private func areaSection(
        title: String,
        areas: [ReadinessAreaReview],
        findings: [ReadinessFinding]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(areas) { area in
                    readinessAreaRow(area, findings: findings.filter { $0.area == area.area })
                    if area.id != areas.last?.id {
                        Divider().padding(.leading, 132)
                    }
                }
            }
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 1))
        }
    }

    private func readinessAreaRow(
        _ area: ReadinessAreaReview,
        findings: [ReadinessFinding]
    ) -> some View {
        let isExpanded = !area.status.isGreen || !findings.isEmpty
        return VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(area.area.label)
                    .font(.caption.weight(.semibold))
                    .frame(width: 116, alignment: .leading)
                    .lineLimit(1)
                Text(area.status.label)
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .foregroundStyle(area.status.color)
                    .frame(width: 92, alignment: .leading)
                    .lineLimit(1)
                Text(area.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(isExpanded ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }

            if isExpanded {
                ForEach(findings.prefix(2)) { finding in
                    findingInline(finding)
                        .padding(.leading, 218)
                }
                if !area.sourceRefs.isEmpty {
                    sourceRefs(area.sourceRefs)
                        .padding(.leading, 218)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, isExpanded ? 10 : 7)
    }

    private func findingInline(_ finding: ReadinessFinding) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Circle()
                .fill(finding.severity.color)
                .frame(width: 6, height: 6)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(finding.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(finding.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func findingsSection(_ findings: [ReadinessFinding]) -> some View {
        if !findings.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Findings")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(findings) { finding in
                    VStack(alignment: .leading, spacing: 6) {
                        findingInline(finding)
                        sourceRefs(finding.sourceRefs)
                    }
                    .padding(10)
                    .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private func memberSection(_ members: [SeriesMemberReadiness]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Member pods")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(members) { member in
                    HStack(spacing: 10) {
                        Text(member.title)
                            .font(.caption.weight(.semibold))
                            .frame(width: 150, alignment: .leading)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(member.status.label)
                            .font(.system(.caption2, design: .monospaced).weight(.semibold))
                            .foregroundStyle(member.status.color)
                            .frame(width: 92, alignment: .leading)
                        Text(member.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    if member.id != members.last?.id {
                        Divider().padding(.leading, 162)
                    }
                }
            }
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 1))
        }
    }

    @ViewBuilder
    private func firewallDenialsSection(_ readiness: ReadinessReview) -> some View {
        if readiness.findings.contains(where: { $0.id == "network-denied-egress" }) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Label("Firewall denials", systemImage: "exclamationmark.shield")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    if !firewallDenials.isEmpty {
                        Text("\(firewallDenials.count)")
                            .font(.system(.caption2, design: .monospaced).weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }

                if isLoadingFirewallDenials {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading firewall denials")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } else if let firewallDenialsError {
                    Text(firewallDenialsError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else if firewallDenials.isEmpty {
                    Text("No firewall denials found for this readiness snapshot.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(firewallDenials.prefix(8)) { denial in
                            firewallDenialRow(denial)
                            if denial.id != firewallDenials.prefix(8).last?.id {
                                Divider().padding(.leading, 132)
                            }
                        }
                    }
                    .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.4), lineWidth: 1))
                    if firewallDenials.count > 8 {
                        Text("+ \(firewallDenials.count - 8) more")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func firewallDenialRow(_ denial: FirewallDenialResponse) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(shortFirewallTimestamp(denial.timestamp))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 116, alignment: .leading)
            Text(denial.sni)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Text(denial.src)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private func refreshFirewallDenials(for readiness: ReadinessReview) async {
        guard readiness.findings.contains(where: { $0.id == "network-denied-egress" }) else {
            firewallDenials = []
            firewallDenialsError = nil
            return
        }
        guard let loadFirewallDenials else { return }
        isLoadingFirewallDenials = true
        firewallDenialsError = nil
        do {
            firewallDenials = try await loadFirewallDenials(
                pod.id,
                iso8601WithFractionalSeconds(readiness.computedAt)
            )
        } catch {
            firewallDenials = []
            firewallDenialsError = error.localizedDescription
        }
        isLoadingFirewallDenials = false
    }

    private func shortFirewallTimestamp(_ timestamp: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = fractional.date(from: timestamp) ?? plain.date(from: timestamp) else {
            return timestamp
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func iso8601WithFractionalSeconds(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private var approvalSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if requiresReason {
                Text("Approval reason required")
                    .font(.callout.weight(.semibold))
                TextEditor(text: $approvalReason)
                    .font(.callout)
                    .frame(minHeight: 78)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(Color(nsColor: .textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor), lineWidth: 1))
            } else if decisionStatus == .needsReview {
                Text("Review the findings, then approve if they are acceptable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Button {
                let reason = approvalReason.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await actions.approve(pod.id, reason.isEmpty ? nil : reason) }
            } label: {
                Label(approvalButtonLabel, systemImage: "checkmark")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(decisionStatus == .ready ? .green : .orange)
            .disabled(!canApprove)
            .help(approvalHelp)
        }
        .readinessPanel()
    }

    private var approvalHelp: String {
        guard let decisionStatus else { return "Readiness is not available yet." }
        if decisionStatus.requiresApprovalReason {
            return "A reason is required for \(decisionStatus.label) readiness."
        }
        if !decisionStatus.canApproveFromReadinessTab {
            return "Readiness is pending or unavailable."
        }
        return "Approve this pod using the current Readiness Review."
    }

    private var approvalButtonLabel: String {
        guard let decisionStatus, decisionStatus.canApproveFromReadinessTab else {
            return "Readiness unavailable"
        }
        return requiresReason ? "Approve with reason" : "Approve after review"
    }

    private func sourceRefs(_ refs: [ReadinessSourceRef]) -> some View {
        FlowLayout(spacing: 6) {
            ForEach(refs) { ref in
                Button {
                    open(ref)
                } label: {
                    Label(ref.label, systemImage: sourceIcon(ref))
                        .font(.caption2)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 180)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
        }
    }

    private func open(_ ref: ReadinessSourceRef) {
        if ref.kind == .pr, let href = ref.href {
            NSWorkspace.shared.open(href)
            return
        }
        if let tab = ref.detailTab {
            onOpenTab(tab)
        }
    }

    private func sourceIcon(_ ref: ReadinessSourceRef) -> String {
        switch ref.kind {
        case .validation: "checkmark.seal"
        case .work, .quality: "doc.text.below.ecg"
        case .logs, .event: "text.line.last.and.arrowtriangle.forward"
        case .diff: "doc.text.magnifyingglass"
        case .pr: "arrow.up.right.square"
        case .evidence: "photo.on.rectangle.angled"
        }
    }

    private func readinessStatusPill(_ status: ReadinessStatus) -> some View {
        Text(status.label)
            .font(.system(.caption2, design: .monospaced).weight(.semibold))
            .foregroundStyle(status.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(status.color.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(status.color.opacity(0.22), lineWidth: 1))
    }
}

private struct ReadinessPanelModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.32))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor).opacity(0.5), lineWidth: 1))
    }
}

private extension View {
    func readinessPanel() -> some View {
        modifier(ReadinessPanelModifier())
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let maxWidth = proposal.width ?? subviews.reduce(CGFloat.zero) { width, subview in
            width + subview.sizeThatFits(.unspecified).width + spacing
        }
        var currentX: CGFloat = 0
        var currentRowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var widestRow: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let wraps = currentX > 0 && currentX + size.width > maxWidth
            if wraps {
                widestRow = max(widestRow, currentX - spacing)
                totalHeight += currentRowHeight + spacing
                currentX = 0
                currentRowHeight = 0
            }
            currentX += size.width + spacing
            currentRowHeight = max(currentRowHeight, size.height)
        }

        widestRow = max(widestRow, currentX > 0 ? currentX - spacing : 0)
        totalHeight += currentRowHeight
        return CGSize(width: min(maxWidth, widestRow), height: totalHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var currentX = bounds.minX
        var currentY = bounds.minY
        var currentRowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let wraps = currentX > bounds.minX && currentX + size.width > bounds.maxX
            if wraps {
                currentX = bounds.minX
                currentY += currentRowHeight + spacing
                currentRowHeight = 0
            }
            subview.place(
                at: CGPoint(x: currentX, y: currentY),
                proposal: ProposedViewSize(width: size.width, height: size.height)
            )
            currentX += size.width + spacing
            currentRowHeight = max(currentRowHeight, size.height)
        }
    }
}
