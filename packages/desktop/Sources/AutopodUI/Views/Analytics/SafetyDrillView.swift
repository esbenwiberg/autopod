import AutopodClient
import Charts
import SwiftUI

// MARK: - SafetyDrillView

/// Right-pane drill for the Safety card. Five sections (locked order per design.md):
/// 1. PII histogram by pattern
/// 2. Quarantine score histogram (10 buckets)
/// 3. Injection attempts table
/// 4. Audit-chain integrity widget
/// 5. Network-policy distribution
struct SafetyDrillView: View {
    let load: ((Int) async throws -> SafetyAnalyticsResponse)?
    let verifyAuditChain: (() async throws -> AuditChainVerifyResponse)?
    let onSelectPod: ((String) -> Void)?

    @State private var response: SafetyAnalyticsResponse?
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var isVerifying = false
    @State private var verifyError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let err = loadError {
                    SafetyInlineErrorBanner(message: "Couldn't load safety data: \(err)")
                }

                if let err = verifyError {
                    SafetyInlineErrorBanner(message: "Verification failed: \(err)")
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    piiHistogramSection
                    Divider()
                    sourceBreakdownSection
                    Divider()
                    quarantineHistogramSection
                    Divider()
                    injectionTableSection
                    Divider()
                    firewallDenialsSection
                    Divider()
                    auditChainSection
                    Divider()
                    worktreeSafetySection
                    Divider()
                    networkPolicySection
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: days) { await fetchData() }
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "shield.lefthalf.filled")
                .foregroundStyle(.secondary)
            Text("Safety Analytics")
                .font(.title3.weight(.semibold))
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            daysPicker
        }
    }

    private var daysPicker: some View {
        Picker("Days", selection: $days) {
            Text("7d").tag(7)
            Text("14d").tag(14)
            Text("30d").tag(30)
            Text("60d").tag(60)
            Text("90d").tag(90)
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .frame(width: 70)
    }

    // MARK: - Section 1: PII histogram

    private var piiHistogramSection: some View {
        let patterns = (response?.byPattern ?? []).filter { $0.kind == .pii }
        return VStack(alignment: .leading, spacing: 8) {
            Text("PII Redactions by Pattern")
                .font(.headline)
            if patterns.isEmpty {
                Text("No PII redactions in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                let sorted = patterns.sorted { $0.count > $1.count }
                Chart(sorted, id: \.patternName) { row in
                    BarMark(
                        x: .value("Count", row.count),
                        y: .value("Pattern", row.patternName)
                    )
                    .foregroundStyle(Color.orange.opacity(0.75))
                    .annotation(position: .trailing, alignment: .leading) {
                        Text("\(row.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(height: CGFloat(sorted.count) * 32 + 20)
            }
        }
    }

    // MARK: - Section 1b: Safety event sources

    private var sourceBreakdownSection: some View {
        let sources = (response?.bySource ?? []).sorted { $0.count > $1.count }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Safety Event Sources")
                .font(.headline)
            if sources.isEmpty {
                Text("No safety event source data in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Chart(sources, id: \.source) { row in
                    BarMark(
                        x: .value("Count", row.count),
                        y: .value("Source", safetySourceLabel(row.source))
                    )
                    .foregroundStyle(Color.purple.opacity(0.65))
                    .annotation(position: .trailing, alignment: .leading) {
                        Text("\(row.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(height: CGFloat(sources.count) * 28 + 20)
            }
        }
    }

    private func safetySourceLabel(_ source: SafetyEventSource) -> String {
        switch source {
        case .actionResponse: return "action response"
        case .mcpProxy: return "mcp proxy"
        case .issueBody: return "issue body"
        case .claudeMdSection: return "claude.md"
        case .skillContent: return "skill content"
        case .podInput: return "pod input"
        case .eventPayload: return "event payload"
        }
    }

    // MARK: - Section 2: Quarantine score histogram

    private var quarantineHistogramSection: some View {
        let buckets = response?.quarantineHistogram ?? []
        return VStack(alignment: .leading, spacing: 8) {
            Text("Quarantine Score Distribution")
                .font(.headline)
            if buckets.allSatisfy({ $0.count == 0 }) || buckets.isEmpty {
                Text("No action quarantine data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Chart(buckets, id: \.bucket) { b in
                    BarMark(
                        x: .value("Bucket", b.bucket),
                        y: .value("Count", b.count)
                    )
                    .foregroundStyle(quarantineBucketColor(b.bucket))
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { _ in
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .frame(height: 120)

                Text("Buckets 0.7–1.0 are high risk")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func quarantineBucketColor(_ bucket: String) -> Color {
        guard let prefix = bucket.split(separator: "-").first,
              let lo = Double(prefix) else { return .accentColor.opacity(0.6) }
        if lo >= 0.7 { return .red.opacity(0.8) }
        if lo >= 0.4 { return .orange.opacity(0.7) }
        return .accentColor.opacity(0.5)
    }

    // MARK: - Section 3: Injection attempts table

    private var injectionTableSection: some View {
        let rows = flatInjectionRows()
        return VStack(alignment: .leading, spacing: 8) {
            Text("Injection Attempts")
                .font(.headline)
            if rows.isEmpty {
                Text("No injection attempts in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Table(rows) {
                    TableColumn("When") { r in
                        Text(analyticsRelativeDate(r.createdAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 90, ideal: 110)

                    TableColumn("Pattern") { r in
                        Text(r.patternName)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                    }
                    .width(min: 100, ideal: 160)

                    TableColumn("Severity") { r in
                        if let sev = r.severity {
                            Text(String(format: "%.2f", sev))
                                .font(.system(.caption, design: .monospaced))
                                .monospacedDigit()
                                .foregroundStyle(sev >= 0.7 ? .red : .primary)
                        } else {
                            Text("—")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .width(min: 60, ideal: 70, max: 80)

                    TableColumn("Pod") { r in
                        if r.podId == "__pre_creation__" {
                            Text("(pre-creation)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        } else {
                            Button {
                                onSelectPod?(r.podId)
                            } label: {
                                Text(String(r.podId.suffix(8)))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.blue)
                            }
                            .buttonStyle(.plain)
                            .help("Open pod \(r.podId)")
                        }
                    }
                    .width(min: 80, ideal: 100)
                }
                .frame(minHeight: 200)
            }
        }
    }

    private struct InjectionRow: Identifiable {
        let id: String
        let createdAt: String
        let patternName: String
        let severity: Double?
        let podId: String
    }

    private func flatInjectionRows() -> [InjectionRow] {
        guard let r = response else { return [] }
        return r.byPod.flatMap { pod in
            pod.topInjections.enumerated().map { offset, inj in
                InjectionRow(
                    id: "\(pod.podId)|\(offset)|\(inj.createdAt)|\(inj.patternName)",
                    createdAt: inj.createdAt,
                    patternName: inj.patternName,
                    severity: inj.severity,
                    podId: pod.podId
                )
            }
        }.sorted { $0.createdAt > $1.createdAt }
    }

    // MARK: - Section 3b: Firewall denials

    private var firewallDenialsSection: some View {
        let denials = response?.firewallDenials
        let total = denials?.total ?? 0
        return VStack(alignment: .leading, spacing: 10) {
            Text("Firewall Blocks")
                .font(.headline)
            if total == 0 {
                Text("No blocked outbound attempts in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    safetyMetricTile(
                        title: "Blocks",
                        value: "\(total)",
                        tint: .red
                    )
                    safetyMetricTile(
                        title: "Pods",
                        value: "\(denials?.affectedPods ?? 0)",
                        tint: .orange
                    )
                    if let top = denials?.topHosts.first {
                        safetyMetricTile(
                            title: "Top host",
                            value: top.sni,
                            tint: .blue
                        )
                    }
                }

                firewallTopHostsView(denials?.topHosts ?? [])
                firewallRecentTable(denials?.recent ?? [])
            }
        }
    }

    private func firewallTopHostsView(_ hosts: [SafetyFirewallHost]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Top Blocked Hosts")
                .font(.subheadline.weight(.medium))
            ForEach(hosts.prefix(5), id: \.sni) { host in
                HStack(spacing: 8) {
                    Text(host.sni)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                    Spacer()
                    Text("\(host.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Text(analyticsRelativeDate(host.lastDeniedAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 3)
            }
        }
    }

    private func firewallRecentTable(_ rows: [SafetyFirewallDenial]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent Blocks")
                .font(.subheadline.weight(.medium))
            Table(Array(rows.prefix(8))) {
                TableColumn("When") { r in
                    Text(analyticsRelativeDate(r.deniedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .width(min: 90, ideal: 110)

                TableColumn("Host") { r in
                    Text(r.sni)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                }
                .width(min: 160, ideal: 260)

                TableColumn("Pod") { r in
                    Button {
                        onSelectPod?(r.podId)
                    } label: {
                        Text(String(r.podId.suffix(8)))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                    .help("Open pod \(r.podId)")
                }
                .width(min: 80, ideal: 100)

                TableColumn("Source") { r in
                    Text(r.src)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .width(min: 80, ideal: 110)
            }
            .frame(minHeight: 160)
        }
    }

    // MARK: - Section 4: Audit-chain integrity

    private var auditChainSection: some View {
        let chain = response?.auditChain
        return VStack(alignment: .leading, spacing: 8) {
            Text("Audit Chain")
                .font(.headline)
            VStack(alignment: .leading, spacing: 10) {
                auditChainStatusRow(chain)
                HStack {
                    Spacer()
                    Button {
                        Task { await runVerification() }
                    } label: {
                        HStack(spacing: 6) {
                            if isVerifying { ProgressView().controlSize(.mini) }
                            Text(isVerifying ? "Verifying…" : "Verify now")
                        }
                    }
                    .disabled(isVerifying || verifyAuditChain == nil)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private func auditChainStatusRow(_ chain: SafetyAuditChainStatus?) -> some View {
        if let valid = chain?.valid {
            if valid {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        if let entries = chain?.totalEntries, let pods = chain?.totalPods {
                            Text("\(entries) entries across \(pods) pods, 0 mismatches")
                                .font(.callout.weight(.medium))
                        }
                        if let at = chain?.lastVerifiedAt {
                            Text("Verified \(analyticsRelativeDate(at))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "xmark.seal.fill")
                        .foregroundStyle(.red)
                    VStack(alignment: .leading, spacing: 2) {
                        if let m = chain?.firstMismatch {
                            Text("Mismatch on pod \(m.podId), row \(m.rowId)")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(.red)
                        }
                        if let at = chain?.lastVerifiedAt {
                            Text("Verified \(analyticsRelativeDate(at))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else {
            Text("No verification on file.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color(nsColor: .separatorColor).opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private func runVerification() async {
        guard let verifyAuditChain else { return }
        isVerifying = true
        verifyError = nil
        defer { isVerifying = false }
        do {
            _ = try await verifyAuditChain()
            await fetchData()
        } catch {
            verifyError = error.localizedDescription
        }
    }

    // MARK: - Section 4b: Worktree safety

    private var worktreeSafetySection: some View {
        let safety = response?.worktreeSafety
        let incidents = safety?.recentIncidents ?? []
        return VStack(alignment: .leading, spacing: 10) {
            Text("Host Worktree Safety")
                .font(.headline)
            HStack(spacing: 12) {
                safetyMetricTile(
                    title: "Current",
                    value: "\(safety?.currentCompromisedPods ?? 0)",
                    tint: (safety?.currentCompromisedPods ?? 0) > 0 ? .red : .green
                )
                safetyMetricTile(
                    title: "Incidents",
                    value: "\(safety?.totalIncidents ?? 0)",
                    tint: (safety?.totalIncidents ?? 0) > 0 ? .orange : .secondary
                )
            }
            Text("Pods cannot see arbitrary laptop paths unless the daemon bind-mounts them. This tracks writable worktree incidents and deletion-guard trips.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if incidents.isEmpty {
                Text("No worktree safety incidents in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Table(Array(incidents.prefix(8))) {
                    TableColumn("When") { r in
                        Text(analyticsRelativeDate(r.detectedAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 90, ideal: 110)

                    TableColumn("Pod") { r in
                        Button {
                            onSelectPod?(r.podId)
                        } label: {
                            Text(String(r.podId.suffix(8)))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.blue)
                        }
                        .buttonStyle(.plain)
                        .help("Open pod \(r.podId)")
                    }
                    .width(min: 80, ideal: 100)

                    TableColumn("Deletions") { r in
                        Text("\(r.deletionCount)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(r.deletionCount > r.threshold ? .red : .primary)
                    }
                    .width(min: 70, ideal: 90)

                    TableColumn("Threshold") { r in
                        Text("\(r.threshold)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 70, ideal: 90)
                }
                .frame(minHeight: 140)
            }
        }
    }

    private func safetyMetricTile(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(10)
        .frame(minWidth: 100, maxWidth: 180, alignment: .leading)
        .background(tint.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Section 5: Network-policy distribution

    private var networkPolicySection: some View {
        let buckets = orderedNetworkPolicyBuckets()
        let total = buckets.reduce(0) { $0 + $1.count }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Network Policy Distribution")
                .font(.headline)
            if total == 0 {
                Text("No network policy data in window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 16) {
                    ForEach(buckets, id: \.bucket) { entry in
                        VStack(spacing: 4) {
                            Text("\(entry.count)")
                                .font(.title2.weight(.bold))
                                .monospacedDigit()
                            Text(entry.bucket.rawValue)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(minWidth: 80)
                        .background(networkPolicyColor(entry.bucket).opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                Text("of \(total) pods in window")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func orderedNetworkPolicyBuckets() -> [SafetyNetworkPolicyCount] {
        let order: [NetworkPolicyBucket] = [.allowAll, .restricted, .denyAll, .unknown]
        let map = Dictionary(grouping: response?.networkPolicy ?? [], by: \.bucket)
            .mapValues { $0.first?.count ?? 0 }
        return order.map { SafetyNetworkPolicyCount(bucket: $0, count: map[$0] ?? 0) }
    }

    private func networkPolicyColor(_ bucket: NetworkPolicyBucket) -> Color {
        switch bucket {
        case .allowAll:   return .green
        case .restricted: return .orange
        case .denyAll:    return .red
        case .unknown:    return .secondary
        }
    }

    // MARK: - Fetch

    private func fetchData() async {
        guard let load else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await load(days)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

// MARK: - Inline error banner

private struct SafetyInlineErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
            Spacer()
        }
        .padding(10)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Preview

#Preview("SafetyDrillView — loading") {
    SafetyDrillView(
        load: { _ in try await Task.sleep(for: .seconds(60)); fatalError() },
        verifyAuditChain: nil,
        onSelectPod: nil
    )
    .frame(width: 700, height: 600)
}
