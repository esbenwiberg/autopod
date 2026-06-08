import AppKit
import AutopodClient
import SwiftUI

public enum EvidenceSection: String, CaseIterable {
  case screenshots, network, actions, artifacts, markdown

  var label: String {
    switch self {
    case .screenshots: "Screenshots"
    case .network: "Network"
    case .actions: "Actions"
    case .artifacts: "Artifacts"
    case .markdown: "Markdown"
    }
  }

  var icon: String {
    switch self {
    case .screenshots: "photo.on.rectangle.angled"
    case .network: "exclamationmark.shield"
    case .actions: "rectangle.stack.badge.person.crop"
    case .artifacts: "doc.on.doc"
    case .markdown: "doc.richtext"
    }
  }
}

/// Evidence tab — proof screenshots, generated artifacts, and rendered markdown
/// outputs in one place so the top-level detail nav stays calm.
public struct EvidenceTab: View {
  public let pod: Pod
  public var loadFiles: ((String) async throws -> [SessionFileEntry])?
  public var loadArtifacts: ((String) async throws -> [SessionFileEntry])?
  public var loadContent: ((String, String) async throws -> SessionFileContent)?
  public var loadFirewallDenials: ((String, String?) async throws -> [FirewallDenialResponse])?
  public var loadActionAudit: ((String, String?) async throws -> ActionAuditResponse)?
  @Binding private var requestedSection: EvidenceSection?

  public init(
    pod: Pod,
    loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
    loadArtifacts: ((String) async throws -> [SessionFileEntry])? = nil,
    loadContent: ((String, String) async throws -> SessionFileContent)? = nil,
    loadFirewallDenials: ((String, String?) async throws -> [FirewallDenialResponse])? = nil,
    loadActionAudit: ((String, String?) async throws -> ActionAuditResponse)? = nil,
    requestedSection: Binding<EvidenceSection?> = .constant(nil)
  ) {
    self.pod = pod
    self.loadFiles = loadFiles
    self.loadArtifacts = loadArtifacts
    self.loadContent = loadContent
    self.loadFirewallDenials = loadFirewallDenials
    self.loadActionAudit = loadActionAudit
    self._requestedSection = requestedSection
  }

  @State private var selectedSection: EvidenceSection = .screenshots
  @State private var lightboxRefs: [ScreenshotRef] = []
  @State private var lightboxIndex: Int = 0
  @State private var isLightboxPresented: Bool = false
  @State private var firewallDenials: [FirewallDenialResponse] = []
  @State private var firewallDenialsError: String?
  @State private var isLoadingFirewallDenials = false
  @State private var actionAudit: ActionAuditResponse?
  @State private var actionAuditError: String?
  @State private var isLoadingActionAudit = false

  private var screenshotSet: [ScreenshotRef] {
    let pageShots = pod.validationChecks?.proofOfWorkScreenshots ?? []
    let reviewShots = pod.validationChecks?.taskReviewScreenshots ?? []
    return pageShots + reviewShots
  }

  private var hasNetworkEvidence: Bool {
    pod.readinessReview?.findings.contains(where: { $0.id == "network-denied-egress" }) == true
      || !firewallDenials.isEmpty
  }

  private var hasActionEvidence: Bool {
    pod.readinessReview?.findings.contains(where: { $0.id.hasPrefix("actions-") }) == true
      || !(actionAudit?.rows.isEmpty ?? true)
  }

  private var visibleSections: [EvidenceSection] {
    EvidenceSection.allCases.filter { section in
      switch section {
      case .network: hasNetworkEvidence
      case .actions: hasActionEvidence
      case .screenshots, .artifacts, .markdown: true
      }
    }
  }

  public var body: some View {
    HSplitView {
      sectionRail
        .frame(minWidth: 150, idealWidth: 170, maxWidth: 210)

      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .overlay {
      if isLightboxPresented, !lightboxRefs.isEmpty {
        ScreenshotLightbox(
          refs: lightboxRefs,
          currentIndex: $lightboxIndex,
          isPresented: $isLightboxPresented
        )
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.18), value: isLightboxPresented)
    .onAppear { consumeRequestedSection() }
    .onChange(of: requestedSection) { _, _ in consumeRequestedSection() }
  }

  private var sectionRail: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Evidence")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
        .tracking(0.4)
        .padding(.horizontal, 12)
        .padding(.top, 12)

      ForEach(visibleSections, id: \.self) { section in
        Button {
          selectedSection = section
        } label: {
          HStack(spacing: 8) {
            Image(systemName: section.icon)
              .font(.system(size: 12))
              .frame(width: 16)
            Text(section.label)
              .font(.subheadline.weight(selectedSection == section ? .semibold : .regular))
              .lineLimit(1)
            Spacer(minLength: 0)
            if let count = sectionBadgeCount(section) {
              Text("\(count)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
          .foregroundStyle(selectedSection == section ? .primary : .secondary)
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 7)
              .fill(selectedSection == section ? Color.white.opacity(0.08) : .clear)
          )
          .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 8)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
  }

  @ViewBuilder
  private var content: some View {
    switch selectedSection {
    case .screenshots:
      screenshotsPane
    case .network:
      networkPane
    case .actions:
      actionsPane
    case .artifacts:
      ArtifactsTab(pod: pod, loadArtifacts: loadArtifacts, loadContent: loadContent)
    case .markdown:
      MarkdownTab(pod: pod, loadFiles: loadFiles, loadContent: loadContent)
    }
  }

  private func sectionBadgeCount(_ section: EvidenceSection) -> Int? {
    switch section {
    case .screenshots:
      screenshotSet.isEmpty ? nil : screenshotSet.count
    case .network:
      firewallDenials.isEmpty ? nil : firewallDenials.count
    case .actions:
      actionAudit?.rows.isEmpty == false ? actionAudit?.rows.count : nil
    case .artifacts, .markdown:
      nil
    }
  }

  private var screenshotsPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: "photo.on.rectangle.angled")
              .foregroundStyle(.green)
            Text("Proof of Work")
              .font(.title3.weight(.semibold))
          }
          Text("Screenshots captured by smoke checks, criteria checks, and task review.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if screenshotSet.isEmpty {
          emptyScreenshots
        } else {
          screenshotGrid
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var screenshotGrid: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 12)], spacing: 12) {
      ForEach(Array(screenshotSet.enumerated()), id: \.element.id) { index, shot in
        ZStack(alignment: .bottomLeading) {
          ScreenshotThumbnail(
            ref: shot,
            allRefs: screenshotSet,
            onOpen: { openLightbox($0) },
            maxHeight: 220,
            fillMode: true
          )
          .frame(maxWidth: .infinity)
          .frame(height: 180)
          .clipped()

          HStack(spacing: 6) {
            Text(shot.source.rawValue.uppercased())
              .font(.system(size: 8, weight: .bold, design: .monospaced))
              .foregroundStyle(.white.opacity(0.9))
              .padding(.horizontal, 5)
              .padding(.vertical, 2)
              .background(Color.white.opacity(0.16), in: Capsule())
            Text(shot.label)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(.white)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 0)
          }
          .padding(7)
          .background(Color.black.opacity(0.62))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture { openLightbox(index) }
      }
    }
  }

  private var emptyScreenshots: some View {
    VStack(spacing: 10) {
      Image(systemName: "photo.on.rectangle")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("No screenshots captured yet")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      Text("Smoke tests, criteria checks, and task review screenshots will appear here.")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
  }

  private var networkPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: "exclamationmark.shield")
              .foregroundStyle(.orange)
            Text("Network Evidence")
              .font(.title3.weight(.semibold))
          }
          Text("Denied outbound connection attempts blocked by policy.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if isLoadingFirewallDenials {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading firewall denials")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 8)
        } else if let firewallDenialsError {
          VStack(alignment: .leading, spacing: 8) {
            Text(firewallDenialsError)
              .font(.caption)
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
            Button("Retry") {
              Task { await refreshFirewallDenials() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }
        } else if firewallDenials.isEmpty {
          emptyNetworkEvidence
        } else {
          firewallDenialList
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task(id: "\(pod.id)-\(pod.readinessReview?.computedAt.timeIntervalSince1970 ?? 0)") {
      await refreshFirewallDenials()
    }
  }

  private var firewallDenialList: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(firewallDenials.count) denied egress event(s)")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)

      VStack(spacing: 0) {
        ForEach(Array(firewallDenials.prefix(20))) { denial in
          firewallDenialRow(denial)
          if denial.id != firewallDenials.prefix(20).last?.id {
            Divider().padding(.leading, 132)
          }
        }
      }
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
      .clipShape(RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color(nsColor: .separatorColor).opacity(0.4), lineWidth: 1)
      )

      if firewallDenials.count > 20 {
        Text("+ \(firewallDenials.count - 20) more")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func firewallDenialRow(_ denial: FirewallDenialResponse) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(shortEvidenceTimestamp(denial.timestamp))
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

  private var emptyNetworkEvidence: some View {
    VStack(spacing: 10) {
      Image(systemName: "checkmark.shield")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("No firewall denials recorded")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
  }

  private var actionsPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: "rectangle.stack.badge.person.crop")
              .foregroundStyle(.orange)
            Text("Action Evidence")
              .font(.title3.weight(.semibold))
          }
          Text("Control-plane action audit rows and safety signals recorded for this pod.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if isLoadingActionAudit {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading action audit")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 8)
        } else if let actionAuditError {
          VStack(alignment: .leading, spacing: 8) {
            Text(actionAuditError)
              .font(.caption)
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
            Button("Retry") {
              Task { await refreshActionAudit() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }
        } else if let actionAudit, !actionAudit.rows.isEmpty {
          actionAuditList(actionAudit)
        } else {
          emptyActionEvidence
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task(id: "\(pod.id)-\(pod.readinessReview?.computedAt.timeIntervalSince1970 ?? 0)") {
      await refreshActionAudit()
    }
  }

  private func actionAuditList(_ response: ActionAuditResponse) -> some View {
    let rows = response.rows
    let piiRows = rows.filter(\.piiDetected)
    let quarantineRows = rows.filter { $0.quarantineScore > 0 }
    let categories = Array(Set(rows.flatMap { $0.piiCategories ?? [] })).sorted()
    let maxQuarantineScore = quarantineRows.map(\.quarantineScore).max() ?? 0

    return VStack(alignment: .leading, spacing: 10) {
      actionAuditSummary(
        rows: rows.count,
        piiRows: piiRows.count,
        categories: categories,
        quarantineRows: quarantineRows.count,
        maxQuarantineScore: maxQuarantineScore,
        chain: response.chain
      )

      VStack(spacing: 0) {
        ForEach(Array(rows.prefix(50))) { row in
          actionAuditRow(row)
          if row.id != rows.prefix(50).last?.id {
            Divider().padding(.leading, 132)
          }
        }
      }
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
      .clipShape(RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color(nsColor: .separatorColor).opacity(0.4), lineWidth: 1)
      )

      if rows.count > 50 {
        Text("+ \(rows.count - 50) more")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func actionAuditSummary(
    rows: Int,
    piiRows: Int,
    categories: [String],
    quarantineRows: Int,
    maxQuarantineScore: Double,
    chain: ActionAuditChainResponse
  ) -> some View {
    FlowLayout(spacing: 6) {
      evidencePill("\(rows) audit row(s)", color: .secondary)
      evidencePill(chain.valid ? "chain valid" : "chain invalid", color: chain.valid ? .green : .red)
      if piiRows > 0 {
        evidencePill("\(piiRows) PII", color: .orange)
      }
      if !categories.isEmpty {
        evidencePill("PII: \(categories.joined(separator: ", "))", color: .orange)
      }
      if quarantineRows > 0 {
        evidencePill(
          "\(quarantineRows) quarantine · max \(formatScore(maxQuarantineScore))",
          color: .orange
        )
      }
      if !chain.valid, let reason = chain.reason {
        evidencePill(reason, color: .red)
      }
    }
  }

  private func actionAuditRow(_ row: ActionAuditEntryResponse) -> some View {
    DisclosureGroup {
      actionAuditDetails(row)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(shortEvidenceTimestamp(row.createdAt))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.secondary)
          .frame(width: 116, alignment: .leading)
        Text(row.actionName)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)
        actionSafetyBadges(row)
        Spacer(minLength: 8)
        if let responseSummary = row.responseSummary, !responseSummary.isEmpty {
          Text(responseSummary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
  }

  private func actionSafetyBadges(_ row: ActionAuditEntryResponse) -> some View {
    HStack(spacing: 4) {
      if row.piiDetected {
        evidencePill("PII", color: .orange)
      }
      if row.quarantineScore > 0 {
        evidencePill("Q \(formatScore(row.quarantineScore))", color: .orange)
      }
    }
  }

  private func actionAuditDetails(_ row: ActionAuditEntryResponse) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      labeledCodeBlock(title: "Params", value: prettyJson(row.params))
      if let responseSummary = row.responseSummary, !responseSummary.isEmpty {
        labeledCodeBlock(title: "Response summary", value: responseSummary)
      }
      if let categories = row.piiCategories, !categories.isEmpty {
        labeledCodeBlock(title: "PII categories", value: categories.joined(separator: ", "))
      }
      labeledCodeBlock(title: "Entry hash", value: row.entryHash ?? "null")
      labeledCodeBlock(title: "Previous hash", value: row.prevHash ?? "null")
    }
    .padding(.leading, 132)
    .padding(.top, 6)
  }

  private func labeledCodeBlock(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(title)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
        Button {
          copy(value)
        } label: {
          Image(systemName: "doc.on.doc")
        }
        .buttonStyle(.plain)
        .help("Copy \(title)")
        Spacer(minLength: 0)
      }
      Text(value)
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .lineLimit(8)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var emptyActionEvidence: some View {
    VStack(spacing: 10) {
      Image(systemName: "checkmark.shield")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("No action audit rows recorded")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
  }

  private func refreshFirewallDenials() async {
    guard let loadFirewallDenials else { return }
    isLoadingFirewallDenials = true
    firewallDenialsError = nil
    do {
      firewallDenials = try await loadFirewallDenials(
        pod.id,
        pod.readinessReview.map { iso8601WithFractionalSeconds($0.computedAt) }
      )
    } catch {
      firewallDenials = []
      firewallDenialsError = error.localizedDescription
    }
    isLoadingFirewallDenials = false
  }

  private func refreshActionAudit() async {
    guard let loadActionAudit else { return }
    isLoadingActionAudit = true
    actionAuditError = nil
    do {
      actionAudit = try await loadActionAudit(
        pod.id,
        pod.readinessReview.map { iso8601WithFractionalSeconds($0.computedAt) }
      )
    } catch {
      actionAudit = nil
      actionAuditError = error.localizedDescription
    }
    isLoadingActionAudit = false
  }

  private func shortEvidenceTimestamp(_ timestamp: String) -> String {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    let sqlite = DateFormatter()
    sqlite.locale = Locale(identifier: "en_US_POSIX")
    sqlite.timeZone = TimeZone(secondsFromGMT: 0)
    sqlite.dateFormat = "yyyy-MM-dd HH:mm:ss"
    guard
      let date = fractional.date(from: timestamp)
        ?? plain.date(from: timestamp)
        ?? sqlite.date(from: timestamp)
    else {
      return timestamp
    }
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter.string(from: date)
  }

  private func evidencePill(_ text: String, color: Color) -> some View {
    Text(text)
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .foregroundStyle(color)
      .lineLimit(1)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(color.opacity(0.12), in: Capsule())
      .overlay(Capsule().stroke(color.opacity(0.22), lineWidth: 1))
  }

  private func formatScore(_ score: Double) -> String {
    String(format: "%.2f", score)
  }

  private func prettyJson(_ params: [String: AnyCodable]) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard
      let data = try? encoder.encode(params),
      let text = String(data: data, encoding: .utf8)
    else {
      return params.sorted { $0.key < $1.key }
        .map { "\($0.key): \($0.value.displayValue)" }
        .joined(separator: "\n")
    }
    return text
  }

  private func copy(_ value: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(value, forType: .string)
  }

  private func consumeRequestedSection() {
    guard let requestedSection else { return }
    selectedSection = requestedSection
    self.requestedSection = nil
  }

  private func iso8601WithFractionalSeconds(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private func openLightbox(_ index: Int) {
    lightboxRefs = screenshotSet
    lightboxIndex = index
    isLightboxPresented = true
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

#Preview("Evidence") {
  EvidenceTab(pod: MockData.validated)
    .frame(width: 900, height: 600)
}
