import AppKit
import SwiftUI

struct ReadinessTab: View {
    let pod: Pod
    let seriesReadiness: SeriesReadinessReview?
    var actions: PodActions = .preview
    var onOpenTab: (DetailTab) -> Void = { _ in }

    @State private var approvalReason = ""

    private var decisionStatus: ReadinessStatus? {
        seriesReadiness?.status ?? pod.readinessReview?.status
    }

    private var requiresReason: Bool {
        decisionStatus?.requiresApprovalReason ?? false
    }

    private var canApprove: Bool {
        guard decisionStatus != nil else { return false }
        return !requiresReason || !approvalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let seriesReadiness {
                    seriesSection(seriesReadiness)
                    if pod.readinessReview != nil {
                        Divider()
                    }
                }

                if let readiness = pod.readinessReview {
                    podSection(readiness)
                } else {
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
        }
        .readinessPanel()
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
                Label(requiresReason ? "Approve with reason" : "Approve after review", systemImage: "checkmark")
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
        return "Approve this pod using the current Readiness Review."
    }

    private func sourceRefs(_ refs: [ReadinessSourceRef]) -> some View {
        FlowLayout(spacing: 6) {
            ForEach(refs) { ref in
                Button {
                    open(ref)
                } label: {
                    Label(ref.label, systemImage: sourceIcon(ref))
                        .font(.caption2)
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

private struct FlowLayout<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: spacing) {
            content()
        }
    }
}
