import AppKit
import AutopodClient
import Foundation
import MarkdownUI
import SwiftUI
import WebKit

public struct ManagedPodsView: View {
  public let pods: [ManagedPodSummary]
  @Binding public var selection: String?
  public let isLoading: Bool
  public let error: String?
  public let onRefresh: () async -> Void

  public var isConnected: Bool
  public var embedded: Bool
  @State private var profileFilter = "all"
  @State private var accountFilter = "all"
  @Environment(\.desktopRedesign) private var redesign
  @State private var searchText = ""
  @State private var filter: ManagedPodFilter = .all

  public init(
    pods: [ManagedPodSummary],
    selection: Binding<String?>,
    isLoading: Bool,
    error: String?,
    onRefresh: @escaping () async -> Void, isConnected: Bool = true, embedded: Bool = false
  ) {
    self.isConnected = isConnected; self.embedded = embedded
    self.pods = pods
    self._selection = selection
    self.isLoading = isLoading
    self.error = error
    self.onRefresh = onRefresh
  }

  private var visiblePods: [ManagedPodSummary] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return pods.filter { pod in
      filter.includes(pod)
        && (profileFilter == "all" || profileFilter == pod.profileId)
        && (accountFilter == "all" || accountFilter == pod.providerAccountId)
        && (query.isEmpty
          || pod.podId.lowercased().contains(query)
          || pod.dispatcherAttemptId.lowercased().contains(query)
          || pod.profileId.lowercased().contains(query)
          || pod.model.lowercased().contains(query)
          || pod.providerAccountId.lowercased().contains(query)
          || pod.state.lowercased().contains(query))
    }
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()

      if pods.isEmpty && isLoading {
        ProgressView("Loading managed inventory…").frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if pods.isEmpty && !isLoading {
        ContentUnavailableView(
          "No Managed Pods",
          systemImage: "shippingbox",
          description: Text("No Dispatcher attempts are visible for this installation.")
        )
      } else if visiblePods.isEmpty {
        ContentUnavailableView {
          Label("No matching managed pods", systemImage: "line.3.horizontal.decrease.circle")
        } description: { Text("Try another state, profile, account or search.") }
        actions: { Button("Clear filters") { searchText = ""; filter = .all; profileFilter = "all"; accountFilter = "all" } }
      } else {
        ScrollView {
          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 270), spacing: 12)],
            spacing: 12
          ) {
            ForEach(visiblePods) { pod in
              Button {
                selection = pod.id
              } label: {
                ManagedPodCard(pod: pod, isSelected: selection == pod.id)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(12)
        }
      }
    }
    .background(redesign ? DesktopTheme.canvas : Color(nsColor: .windowBackgroundColor))
    .task {
      while !Task.isCancelled {
        await onRefresh()
        do {
          try await Task.sleep(for: .seconds(5))
        } catch {
          return
        }
      }
    }
  }

  private var header: some View {
    VStack(spacing: 10) {
      if !embedded {
      HStack(spacing: 10) {
        Text("Managed Pods")
          .font(.title3.weight(.semibold))
        Text(pods.count.formatted())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(.secondary.opacity(0.12), in: Capsule())
        Spacer()
        if isLoading { ProgressView().controlSize(.small) }
        Button {
          Task { await onRefresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .help("Refresh managed pods")
        .disabled(isLoading)
      }

      }
      HStack(spacing: 8) {
        HStack(spacing: 6) {
          Image(systemName: "magnifyingglass")
            .foregroundStyle(.tertiary)
          TextField("Search managed pods", text: $searchText)
            .textFieldStyle(.plain)
          if !searchText.isEmpty {
            Button {
              searchText = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 7))

        Menu {
          Picker("Show", selection: $filter) {
            ForEach(ManagedPodFilter.allCases) { option in
              Label(option.label, systemImage: option.icon).tag(option)
            }
          }
        } label: {
          Label(filter.label, systemImage: "line.3.horizontal.decrease.circle")
            .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }

      if redesign {
        HStack {
          Picker("Profile", selection: $profileFilter) {
            Text("All profiles").tag("all")
            ForEach(Array(Set(pods.map(\.profileId))).sorted(), id: \.self) { Text($0).tag($0) }
          }
          Picker("Account", selection: $accountFilter) {
            Text("All accounts").tag("all")
            ForEach(Array(Set(pods.map(\.providerAccountId))).sorted(), id: \.self) { Text($0).tag($0) }
          }
        }.controlSize(.small)
      }
      if let error {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

private enum ManagedPodFilter: String, CaseIterable, Identifiable {
  case all
  case active
  case review
  case complete

  var id: String { rawValue }

  var label: String {
    switch self {
    case .all: "All"
    case .active: "Active"
    case .review: "Needs review"
    case .complete: "Complete"
    }
  }

  var icon: String {
    switch self {
    case .all: "shippingbox"
    case .active: "bolt.fill"
    case .review: "exclamationmark.triangle.fill"
    case .complete: "checkmark.circle.fill"
    }
  }

  func includes(_ pod: ManagedPodSummary) -> Bool {
    switch self {
    case .all: true
    case .active: ["queued", "running", "validating"].contains(pod.state)
    case .review: ["review_required", "failed", "killed"].contains(pod.state)
    case .complete: ["complete", "validated"].contains(pod.state)
    }
  }
}

private struct ManagedPodCard: View {
  let pod: ManagedPodSummary
  let isSelected: Bool
  @Environment(\.desktopRedesign) private var redesign
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text(managedPodDisplayName(pod.podId)).font(.system(.callout, design: .monospaced).weight(.semibold)).lineLimit(1).help(pod.podId)
        Spacer(minLength: 4); ManagedStateBadge(state: pod.state)
      }
      Text("\(pod.profileId) · v\(pod.profileVersion)").font(.caption).foregroundStyle(.secondary).lineLimit(2)
      VStack(alignment: .leading, spacing: 5) {
        Text("\(pod.runtime) / \(pod.model)")
        Text(pod.providerAccountId)
      }.font(.caption).foregroundStyle(DesktopTheme.accent).lineLimit(2)
      HStack(spacing: 24) {
        metric(pod.providerRequests.formatted(), "Requests")
        metric(compactCount(pod.consumedTokens) + (pod.tokenUsageKnown ? "" : "*"), pod.tokenUsageKnown ? "Tokens" : "Tokens · partial")
      }.padding(.vertical, 4)
      Divider()
      VStack(alignment: .leading, spacing: 7) {
        Label(pod.failure == nil ? "Provider · route selected" : "Provider · failure recorded", systemImage: "point.3.connected.trianglepath.dotted")
        Label("Validation · \(managedValidationLabel(pod.validationStatus))", systemImage: "checkmark.shield")
        Label("Runtime · \(pod.exitCode.map { "exit \($0)" } ?? (pod.observedExit ? "exit observed" : "exit not observed"))", systemImage: "terminal")
      }.font(.caption2).foregroundStyle(.secondary)
      HStack {
        Text(pod.lastEventDate, style: .relative)
        Spacer()
        if !pod.limitations.isEmpty { Label("\(pod.limitations.count)", systemImage: "exclamationmark.circle") }
        Image(systemName: "arrow.right")
      }.font(.caption2).foregroundStyle(.secondary)
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(isSelected ? DesktopTheme.selection : DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(isSelected ? DesktopTheme.accent : DesktopTheme.line, lineWidth: isSelected ? 1.5 : 1))
      .accessibilityLabel("\(managedPodDisplayName(pod.podId)), \(managedStateLabel(pod.state)), \(pod.profileId)")
      .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
  private func metric(_ value: String, _ label: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(value).font(.system(size: 20, weight: .medium, design: .monospaced))
      Text(label).font(.caption2).foregroundStyle(.secondary)
    }
  }
}

public struct ManagedPodDetailView: View {
  private let initialPod: ManagedPodSummary
  public var pod: ManagedPodSummary {
    detail?.pod.podId == initialPod.podId ? detail!.pod : initialPod
  }
  public let api: DaemonAPI?

  @Environment(\.desktopRedesign) private var redesign
  @State private var detailTab: String
  @State private var detail: ManagedPodDetailResponse?
  @State private var detailError: String?
  @State private var didCopyId = false

  public init(pod: ManagedPodSummary, api: DaemonAPI? = nil, initialDetail: ManagedPodDetailResponse? = nil, initialTab: String = "Overview") {
    _detailTab = State(initialValue: initialTab); _detail = State(initialValue: initialDetail)
    self.initialPod = pod
    self.api = api
  }

  public var body: some View {
    Group { if redesign { desktopBody } else { legacyBody } }
    .task(id: pod.podId) {
      guard let api else { return }
      detail = nil
      detailError = nil
      while !Task.isCancelled {
        do {
          let fetched = try await api.getManagedPod(pod.podId)
          guard !Task.isCancelled else { return }
          detail = fetched
          detailError = nil
        } catch {
          if !Task.isCancelled { detailError = error.localizedDescription }
        }
        do {
          try await Task.sleep(for: .seconds(5))
        } catch {
          return
        }
      }
    }
  }

  private var legacyBody: some View {
    VStack(spacing: 0) {
      detailHeader
      HStack(spacing: 6) {
        Label("Overview", systemImage: "rectangle.grid.1x2")
          .font(.caption.weight(.semibold))
          .foregroundStyle(Color.accentColor)
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
        Spacer()
        Label("Dispatcher managed", systemImage: "lock.shield")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          statusBanner

          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 120), spacing: 8)],
            spacing: 8
          ) {
            metricTile(
              icon: "arrow.up.arrow.down",
              value: pod.providerRequests.formatted(),
              label: "Provider requests"
            )
            metricTile(
              icon: "number",
              value: compactCount(pod.consumedTokens),
              label: pod.tokenUsageKnown ? "Observed tokens" : "Tokens (partial)"
            )
            metricTile(
              icon: "clock",
              value: managedDuration(pod),
              label: "Duration"
            )
            metricTile(
              icon: pod.observedExit ? "checkmark.circle" : "hourglass",
              value: pod.exitCode.map { "Exit \($0)" } ?? (pod.observedExit ? "Observed" : "Pending"),
              label: "Runtime exit"
            )
          }

          if let failure = pod.failure {
            failureCard(failure)
          }

          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 230), spacing: 10, alignment: .top)],
            spacing: 10
          ) {
            routeCard
            identityCard
            validationCard
            deliveryCard
          }

          if !pod.limitations.isEmpty {
            limitationsCard
          }

          artifactsCard
          timelineCard

          if let detailError {
            Label(detailError, systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(.orange)
          }
        }
        .padding(14)
      }
    }

  }

  private var desktopBody: some View {
    VStack(spacing: 0) {
      detailHeader
      DesktopSectionPicker(title: "", items: ["Overview", "Validation", "Delivery", "Artifacts", "Activity"], selection: $detailTab, label: { $0 })
      if let detailError {
        Label("Refresh failed · showing the last loaded detail. " + detailError, systemImage: "exclamationmark.triangle")
          .font(.caption).foregroundStyle(.orange).padding(14).textSelection(.enabled)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if detailTab == "Validation" { validationCard }
          else if detailTab == "Delivery" { deliveryCard }
          else if detailTab == "Artifacts" { artifactsCard }
          else if detailTab == "Activity" { timelineCard }
          else {
            statusBanner
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 125))], spacing: 10) {
              metricTile(icon: "arrow.up.arrow.down", value: pod.providerRequests.formatted(), label: "Provider requests")
              metricTile(icon: "number", value: compactCount(pod.consumedTokens), label: pod.tokenUsageKnown ? "Observed tokens" : "Tokens · partial")
              metricTile(icon: "clock", value: managedDuration(pod), label: "Duration")
              metricTile(icon: "terminal", value: pod.exitCode.map { "Exit \($0)" } ?? (pod.observedExit ? "Observed" : "Pending"), label: "Runtime exit")
            }
            if let failure = pod.failure { failureCard(failure) }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), alignment: .top)], spacing: 16) { routeCard; identityCard }
            if !pod.limitations.isEmpty { limitationsCard }
            Text("Repository identity and task titles are not reported by this managed inventory.").font(.caption).foregroundStyle(.secondary)
          }
        }.padding(24)
      }
    }.background(DesktopTheme.surface)
  }

  private var detailHeader: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle()
          .fill(managedStateColor(pod.state).opacity(0.14))
          .frame(width: 34, height: 34)
        Image(systemName: managedStateIcon(pod.state))
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(managedStateColor(pod.state))
      }

      VStack(alignment: .leading, spacing: 3) {
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(pod.podId, forType: .string)
          didCopyId = true
          Task {
            try? await Task.sleep(for: .seconds(1.5))
            didCopyId = false
          }
        } label: {
          HStack(spacing: 6) {
            Text(managedPodDisplayName(pod.podId))
              .font(.system(.title3, design: .monospaced).weight(.semibold))
              .foregroundStyle(managedStateColor(pod.state))
              .lineLimit(1)
            Image(systemName: didCopyId ? "checkmark" : "doc.on.doc")
              .font(.system(size: 10))
              .foregroundStyle(didCopyId ? .green : .secondary)
          }
        }
        .buttonStyle(.plain)
        .help(didCopyId ? "Copied" : "Copy full managed pod ID")

        HStack(spacing: 5) {
          Text("\(pod.profileId) v\(pod.profileVersion)")
          Text("·").foregroundStyle(.quaternary)
          Text(pod.model)
          Text("·").foregroundStyle(.quaternary)
          Text(pod.lastEventDate, style: .relative)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      }

      Spacer(minLength: 8)
      ManagedStateBadge(state: pod.state)
      if redesign {
        Menu {
          Button("Copy pod ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(pod.podId, forType: .string) }
          Button("Copy attempt ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(pod.dispatcherAttemptId, forType: .string) }
        } label: { Text("Actions ···") }.menuStyle(.borderlessButton).fixedSize()
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 12)
    .background(redesign ? DesktopTheme.surface : Color(nsColor: .windowBackgroundColor))
  }

  private var statusBanner: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: managedStateIcon(pod.state))
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(managedStateColor(pod.state))
      VStack(alignment: .leading, spacing: 3) {
        Text(managedStateHeadline(pod.state))
          .font(.subheadline.weight(.semibold))
        Text(managedStateSummary(pod))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      Text(managedStateLabel(pod.state))
        .font(.caption2.weight(.semibold))
        .foregroundStyle(managedStateColor(pod.state))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(managedStateColor(pod.state).opacity(0.12), in: Capsule())
    }
    .padding(12)
    .background(
      managedStateColor(pod.state).opacity(0.07),
      in: RoundedRectangle(cornerRadius: 10)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .stroke(managedStateColor(pod.state).opacity(0.18), lineWidth: 1)
    )
  }

  private func metricTile(icon: String, value: String, label: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: icon)
        .font(.system(size: 11))
        .foregroundStyle(.tertiary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: 1) {
        Text(value)
          .font(.system(.subheadline, design: .monospaced).weight(.semibold))
          .monospacedDigit()
          .lineLimit(1)
        Text(label)
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(10)
    .background((redesign ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)), in: RoundedRectangle(cornerRadius: 9))
  }

  private var routeCard: some View {
    detailCard("Route", icon: "point.3.connected.trianglepath.dotted") {
      detailRow("Provider account", pod.providerAccountId)
      detailRow("Model", pod.model)
      detailRow("Runtime", pod.runtime)
      detailRow("Target", pod.executionTarget)
      detailRow("Reasoning", pod.reasoning)
    }
  }

  private var identityCard: some View {
    detailCard("Identity", icon: "number.square") {
      detailRow("Managed pod", pod.podId, monospaced: true)
      detailRow("Dispatcher attempt", pod.dispatcherAttemptId, monospaced: true)
      detailRow("Profile", "\(pod.profileId) · v\(pod.profileVersion)")
      detailRow("Cleanup", pod.cleanup)
      detailRow("Grant revoked", pod.revoked ? "Yes" : "No")
      detailRow("Stop requested", pod.stopRequested ? "Yes" : "No")
    }
  }

  private var validationCard: some View {
    detailCard("AutoPod validation", icon: "checkmark.shield") {
      HStack {
        Text(managedValidationLabel(detail?.pod.validationStatus ?? pod.validationStatus))
          .font(.subheadline.weight(.medium))
        Spacer()
        if !(detail?.validations.isEmpty ?? true) {
          Text("\(detail?.validations.count ?? 0) run(s)")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }

      ForEach(detail?.validations ?? []) { run in
        Divider()
        detailRow("Validation ID", run.validationId, monospaced: true)
        detailRow("Status", run.status)
        detailRow("Mode", run.mode)
        detailRow("Receipt digest", run.receiptDigest, monospaced: true)
        detailRow("Checked commit", run.newCommit, monospaced: true)
        if !run.reason.isEmpty {
          Text(run.reason)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        ForEach(run.phases) { phase in
          HStack(spacing: 6) {
            Image(systemName: phase.status == "passed" ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(phase.status == "passed" ? .green : .secondary)
            Text(phase.phase.capitalized)
            Text(phase.status).foregroundStyle(.secondary)
            Spacer()
            Text(String(format: "%.1fs", Double(phase.durationMs) / 1000))
              .monospacedDigit()
              .foregroundStyle(.secondary)
          }
          .font(.caption)
        }
      }
    }
  }

  private var deliveryCard: some View {
    detailCard("Source delivery", icon: "arrow.triangle.branch") {
      detailRow("Dispatcher verification", detail?.verification?.status ?? "Not received")
      if detail?.candidates.isEmpty ?? true, detail?.source.isEmpty ?? true {
        Text("No candidate or source receipt has been recorded.")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      ForEach(detail?.candidates ?? []) { candidate in
        detailRow("Candidate commit", candidate.newCommit, monospaced: true)
      }
      ForEach(detail?.source ?? []) { receipt in
        Divider()
        detailRow("Operation key", receipt.operationKey, monospaced: true)
        detailRow(receipt.operation.capitalized, receipt.status)
        detailRow("Branch", receipt.head, monospaced: true)
        if receipt.pullRequestId > 0 {
          detailRow("Draft PR", "#\(receipt.pullRequestId)")
        }
      }
    }
  }

  private func failureCard(_ failure: ManagedPodFailure) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 4) {
        Text("Provider failure during \(failure.phase)")
          .font(.subheadline.weight(.semibold))
        Text(failure.reason)
          .font(.caption)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
        if let status = failure.httpStatus {
          Text("HTTP \(status)")
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.tertiary)
        }
      }
      Spacer()
    }
    .padding(12)
    .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.orange.opacity(0.20)))
  }

  private var limitationsCard: some View {
    detailCard("Limitations", icon: "exclamationmark.circle") {
      ForEach(pod.limitations, id: \.self) { limitation in
        HStack(alignment: .top, spacing: 7) {
          Image(systemName: "circle.fill")
            .font(.system(size: 4))
            .foregroundStyle(.orange)
            .padding(.top, 5)
          Text(limitation)
            .font(.caption)
        }
      }
    }
  }

  private var artifactsCard: some View {
    detailCard("Artifacts", icon: "shippingbox.fill") {
      if pod.artifacts.isEmpty {
        Text("No committed or pending artifacts")
          .font(.caption)
          .foregroundStyle(.tertiary)
      } else {
        ForEach(detail?.pod.artifacts ?? pod.artifacts) { artifact in
          VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
              Image(systemName: artifact.status == "committed" ? "checkmark.circle.fill" : "clock")
                .foregroundStyle(artifact.status == "committed" ? .green : .secondary)
              VStack(alignment: .leading, spacing: 2) {
                Text(artifact.artifactId)
                  .font(.system(.caption, design: .monospaced).weight(.medium))
                  .lineLimit(1)
                  .truncationMode(.middle)
                  .textSelection(.enabled)
                Text("\(artifact.fileCount) files · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.totalBytes), countStyle: .file))")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Text(artifact.status.capitalized)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(artifact.status == "committed" ? .green : .secondary)
            }
            if let committedAt = artifact.committedAt { Text("Committed: " + Date(timeIntervalSince1970: TimeInterval(committedAt)).formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary) }
            if artifact.status == "committed", let api {
              ManagedArtifactInspector(artifact: artifact, api: api)
            }
          }
          if artifact.id != (detail?.pod.artifacts ?? pod.artifacts).last?.id {
            Divider()
          }
        }
      }
    }
  }

  private var timelineCard: some View {
    let events = Array((detail?.events ?? []).sorted { $0.createdAt > $1.createdAt }.prefix(12))
    return detailCard("Recent activity", icon: "clock.arrow.circlepath") {
      if events.isEmpty {
        Text("Activity will appear as Dispatcher events arrive.")
          .font(.caption)
          .foregroundStyle(.tertiary)
      } else {
        ForEach(events) { event in
          HStack(spacing: 9) {
            Circle()
              .fill(managedEventColor(event.kind))
              .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 4) {
              Text(event.kind.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption)
              Text(event.eventId).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            Text(Date(timeIntervalSince1970: TimeInterval(event.createdAt)), style: .time)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.tertiary)
          }
        }
      }
    }
  }

  private func detailCard<Content: View>(
    _ title: String,
    icon: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      Label(title, systemImage: icon)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .padding(12)
    .background((redesign ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor)), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.07)))
  }

  private func detailRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption2)
        .foregroundStyle(.tertiary)
      Text(value)
        .font(monospaced ? .system(.caption, design: .monospaced) : .caption)
        .lineLimit(monospaced ? 1 : nil)
        .truncationMode(.middle)
        .textSelection(.enabled)
        .help(monospaced ? value : "")
    }
  }
}

func managedPodDisplayName(_ podId: String) -> String {
  guard podId.hasPrefix("managed-") else { return podId }
  let suffix = podId.dropFirst("managed-".count)
  guard suffix.count > 8 else { return podId }
  return "managed-\(suffix.prefix(8))"
}

func managedValidationLabel(_ status: String?) -> String {
  if status == "disabled" { return "Disabled" }
  return (status ?? "not requested").replacingOccurrences(of: "-", with: " ").capitalized
}

private func managedStateLabel(_ state: String) -> String {
  state.replacingOccurrences(of: "_", with: " ").capitalized
}

private func managedStateColor(_ state: String) -> Color {
  switch state {
  case "queued", "running", "validating": .blue
  case "validated", "complete": .green
  case "review_required": .orange
  case "failed", "killed": .red
  default: .secondary
  }
}

private func managedStateIcon(_ state: String) -> String {
  switch state {
  case "queued": "clock"
  case "running": "bolt.fill"
  case "validating": "checkmark.shield"
  case "validated", "complete": "checkmark.circle.fill"
  case "review_required": "exclamationmark.triangle.fill"
  case "failed": "xmark.octagon.fill"
  case "killed": "xmark.circle.fill"
  default: "circle.fill"
  }
}

private func managedStateHeadline(_ state: String) -> String {
  switch state {
  case "queued": "Attempt queued"
  case "running": "Provider work in progress"
  case "validating": "Validation in progress"
  case "validated": "Validation complete"
  case "complete": "Managed attempt complete"
  case "review_required": "Dispatcher review required"
  case "failed": "Managed attempt failed"
  case "killed": "Managed attempt stopped"
  default: managedStateLabel(state)
  }
}

private func managedStateSummary(_ pod: ManagedPodSummary) -> String {
  if let failure = pod.failure { return failure.reason }
  switch pod.state {
  case "queued": return "AutoPod is waiting for the bounded attempt to start."
  case "running": return "Runtime evidence is streaming back to the Dispatcher."
  case "validating": return "The requested deterministic validation is running."
  case "validated": return "Validation evidence is ready for Dispatcher verification."
  case "complete": return "The runtime exited cleanly and cleanup was observed."
  case "review_required": return "The attempt needs a Dispatcher-side decision before it can proceed."
  case "failed": return "The provider or runtime could not complete this attempt."
  case "killed": return "The attempt was stopped before normal completion."
  default: return "Read-only evidence for this Dispatcher-managed attempt."
  }
}

private func compactCount(_ count: Int) -> String {
  if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
  if count >= 1_000 { return String(format: "%.1fK", Double(count) / 1_000) }
  return count.formatted()
}

private func managedDuration(_ pod: ManagedPodSummary) -> String {
  let end = ["queued", "running", "validating"].contains(pod.state)
    ? Date()
    : pod.lastEventDate
  let seconds = max(0, Int(end.timeIntervalSince(pod.createdDate)))
  if seconds >= 3_600 { return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m" }
  if seconds >= 60 { return "\(seconds / 60)m" }
  return "\(seconds)s"
}

private func managedEventColor(_ kind: String) -> Color {
  let lowercased = kind.lowercased()
  if lowercased.contains("fail") || lowercased.contains("kill") { return .red }
  if lowercased.contains("complete") || lowercased.contains("commit") { return .green }
  if lowercased.contains("validat") { return .blue }
  if lowercased.contains("review") { return .orange }
  return .secondary
}

private struct ManagedArtifactInspector: View {
  let artifact: ManagedArtifactSummary
  let api: DaemonAPI
  @Environment(\.desktopOpenManagedArtifact) private var openArtifact
  @State private var isViewerPresented = false
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Button {
        if let openArtifact { openArtifact(artifact) } else { isViewerPresented = true }
      } label: { Label("Open", systemImage: "doc.richtext") }.buttonStyle(.bordered).controlSize(.small)
      ManagedArtifactDownloadControl(artifact: artifact, api: api)
    }.sheet(isPresented: $isViewerPresented) { ManagedArtifactViewer(artifact: artifact, api: api) }
  }
}

private struct ManagedArtifactDownloadControl: View {
  let artifact: ManagedArtifactSummary
  let api: DaemonAPI
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Button {
        Task { @MainActor in
          let panel = NSSavePanel(); panel.nameFieldStringValue = "\(artifact.artifactId).tar.gz"
          guard await panel.begin() == .OK, let url = panel.url else { return }
          busy = true; error = nil
          defer { busy = false }
          do { let data = try await api.downloadManagedArtifact(artifact.artifactId); try data.write(to: url, options: .atomic) }
          catch { self.error = error.localizedDescription }
        }
      } label: { Label(busy ? "Downloading…" : "Download bundle", systemImage: "arrow.down.circle") }
        .buttonStyle(.bordered).controlSize(.small).disabled(busy)
      if let error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).frame(maxWidth: 260) }
    }
  }
}

enum ManagedArtifactPreviewKind: Equatable {
  case markdown
  case text
  case image
  case unavailable
}

func managedArtifactPreviewKind(path: String, mediaType: String) -> ManagedArtifactPreviewKind {
  let extensionName = URL(fileURLWithPath: path).pathExtension.lowercased()
  if mediaType == "text/markdown" || ["md", "markdown"].contains(extensionName) {
    return .markdown
  }
  if mediaType.hasPrefix("image/") || ["png", "jpg", "jpeg", "gif"].contains(extensionName) {
    return .image
  }
  let textExtensions = Set([
    "txt", "log", "html", "htm", "json", "jsonl", "yaml", "yml", "xml", "csv", "tsv",
    "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "js", "jsx", "ts", "tsx", "css",
    "scss", "py", "rb", "go", "rs", "swift", "java", "kt", "kts", "c", "cc", "cpp", "h",
    "hpp", "cs", "sql",
  ])
  if mediaType.hasPrefix("text/")
    || ["application/json", "application/yaml", "application/xml"].contains(mediaType)
    || textExtensions.contains(extensionName)
  {
    return .text
  }
  return .unavailable
}

struct ManagedArtifactViewer: View {
  let artifact: ManagedArtifactSummary
  let api: DaemonAPI
  var onClose: (() -> Void)? = nil
  var initialPath: String? = nil
  @Environment(\.desktopRedesign) private var redesign

  @Environment(\.dismiss) private var dismiss
  @State private var manifest: ManagedArtifactManifest?
  @State private var selectedPath: String?
  @State private var contents: [String: Data] = [:]
  @State private var isLoadingManifest = true
  @State private var isLoadingFile = false
  @State private var loadingPath: String?
  @State private var manifestError: String?
  @State private var fileError: String?
  @State private var htmlPreviewMode = ManagedHTMLPreviewMode.rendered

  private var selectedFile: ManagedArtifactFile? {
    manifest?.files.first { $0.path == selectedPath }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "shippingbox.fill")
          .font(.title3)
          .foregroundStyle(.purple)
        VStack(alignment: .leading, spacing: 2) {
          Text("Artifact viewer")
            .font(.headline)
          Text(artifact.artifactId)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        }
        Spacer()
        Text("\(artifact.fileCount) file\(artifact.fileCount == 1 ? "" : "s")")
          .font(.caption)
          .foregroundStyle(.secondary)
        ManagedArtifactDownloadControl(artifact: artifact, api: api)
        Button(onClose == nil ? "Done" : "Back to attempt") { if let onClose { onClose() } else { dismiss() } }
          .keyboardShortcut(.cancelAction)
      }
      .padding(14)

      Divider()

      if isLoadingManifest {
        ProgressView("Loading artifact…")
          .controlSize(.small)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let manifestError {
        VStack { artifactViewerMessage("Artifact unavailable", detail: manifestError, icon: "exclamationmark.triangle")
          Button("Retry") { Task { await loadManifest() } }.padding(.bottom, 24)
        }
      } else if let manifest {
        HStack(spacing: 0) {
          fileSidebar(manifest)
            .frame(width: 260)
          Divider()
          previewPane(manifest)
        }
      }
    }
    .frame(minWidth: onClose == nil ? 900 : 650, minHeight: 580)
    .background(redesign ? DesktopTheme.surface : Color(nsColor: .windowBackgroundColor))
    .task { await loadManifest() }
    .task(id: selectedPath) { await loadSelectedFile() }
  }

  private func fileSidebar(_ manifest: ManagedArtifactManifest) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("FILES")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
      ScrollView {
        LazyVStack(spacing: 2) {
          ForEach(manifest.files) { file in
            Button {
              selectedPath = file.path
            } label: {
              HStack(spacing: 9) {
                Image(systemName: managedArtifactFileIcon(file))
                  .frame(width: 16)
                  .foregroundStyle(selectedPath == file.path ? DesktopTheme.accent : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                  Text(file.path)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                    .font(.caption2)
                    .opacity(0.7)
                }
                Spacer(minLength: 0)
              }
              .foregroundStyle(selectedPath == file.path ? DesktopTheme.accent : Color.primary)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(
                selectedPath == file.path ? DesktopTheme.selection : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
              )
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 8)
      }
      Divider()
      VStack(alignment: .leading, spacing: 3) {
        Text(manifest.bundle.format.uppercased())
          .font(.caption2.weight(.semibold))
        Text(ByteCountFormatter.string(fromByteCount: Int64(manifest.bundle.size), countStyle: .file)).font(.caption2).foregroundStyle(.secondary)
        Text("SHA-256").font(.caption2).foregroundStyle(.secondary)
        Text(manifest.bundle.sha256)
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
          .help(manifest.bundle.sha256)
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.6))
  }

  @ViewBuilder
  private func previewPane(_ manifest: ManagedArtifactManifest) -> some View {
    if let file = selectedFile {
      VStack(spacing: 0) {
        HStack(spacing: 8) {
          Image(systemName: managedArtifactFileIcon(file))
            .foregroundStyle(.secondary)
          Text(file.path)
            .font(.system(.caption, design: .monospaced).weight(.medium))
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
          Spacer()
          if managedArtifactIsHTML(file.path) {
            Label("Sandboxed", systemImage: "shield.checkered")
              .font(.caption2)
              .foregroundStyle(.secondary)
            Picker("HTML display", selection: $htmlPreviewMode) {
              ForEach(ManagedHTMLPreviewMode.allCases) { mode in
                Text(mode.label).tag(mode)
              }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .controlSize(.small)
            .frame(width: 145)
          }
          Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        Divider()

        previewBody(file, bundle: manifest.bundle)
      }
    } else {
      artifactViewerMessage("Select a file", detail: nil, icon: "doc.text.magnifyingglass")
    }
  }

  @ViewBuilder
  private func previewBody(_ file: ManagedArtifactFile, bundle: ManagedArtifactBundle) -> some View {
    let kind = managedArtifactPreviewKind(path: file.path, mediaType: file.mediaType)
    if kind == .unavailable {
      artifactViewerMessage(
        "Preview not available",
        detail: "This file type stays inside the verified bundle. Download the artifact to open it with a compatible app.",
        icon: "doc.badge.ellipsis"
      )
    } else if isLoadingFile && contents[file.path] == nil {
      ProgressView("Loading \(file.path)…")
        .controlSize(.small)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let fileError {
      artifactViewerMessage("Couldn’t load preview", detail: fileError, icon: "exclamationmark.triangle")
    } else if let data = contents[file.path] {
      switch kind {
      case .markdown:
        if let text = String(data: data, encoding: .utf8) {
          ScrollView {
            Markdown(text)
              .markdownTheme(.autopod)
              .textSelection(.enabled)
              .padding(24)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        } else {
          artifactViewerMessage("Preview not available", detail: "The file is not valid UTF-8 text.", icon: "doc.badge.ellipsis")
        }
      case .text:
        if let text = managedArtifactDisplayText(data, path: file.path) {
          if managedArtifactIsHTML(file.path), htmlPreviewMode == .rendered {
            ManagedSandboxedHTMLView(source: text)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          } else {
            ScrollView([.horizontal, .vertical]) {
              Text(text)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(20)
            }
          }
        } else {
          artifactViewerMessage("Preview not available", detail: "The file is not valid UTF-8 text.", icon: "doc.badge.ellipsis")
        }
      case .image:
        if let image = NSImage(data: data) {
          ScrollView([.horizontal, .vertical]) {
            Image(nsImage: image)
              .resizable()
              .interpolation(.high)
              .scaledToFit()
              .padding(24)
          }
        } else {
          artifactViewerMessage("Preview not available", detail: "The image format could not be decoded.", icon: "photo.badge.exclamationmark")
        }
      case .unavailable:
        EmptyView()
      }
    } else {
      artifactViewerMessage("Select a file", detail: nil, icon: "doc.text.magnifyingglass")
    }
  }

  private func artifactViewerMessage(
    _ title: String,
    detail: String?,
    icon: String
  ) -> some View {
    VStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text(title)
        .font(.headline)
      if let detail {
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 420)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(30)
  }

  @MainActor
  private func loadManifest() async {
    isLoadingManifest = true
    defer { isLoadingManifest = false }
    do {
      let loaded = try await api.getManagedArtifactManifest(artifact.artifactId)
      manifest = loaded
      selectedPath = loaded.files.first(where: { $0.path == initialPath })?.path ?? loaded.files.first(where: {
        managedArtifactPreviewKind(path: $0.path, mediaType: $0.mediaType) != .unavailable
      })?.path ?? loaded.files.first?.path
      manifestError = nil
    } catch {
      manifestError = error.localizedDescription
    }
  }

  @MainActor
  private func loadSelectedFile() async {
    fileError = nil
    isLoadingFile = false
    guard let manifest, let file = selectedFile else { return }
    guard managedArtifactPreviewKind(path: file.path, mediaType: file.mediaType) != .unavailable else {
      fileError = nil
      return
    }
    guard contents[file.path] == nil else { return }
    isLoadingFile = true
    loadingPath = file.path
    fileError = nil
    defer { if loadingPath == file.path { isLoadingFile = false; loadingPath = nil } }
    do {
      let data = try await api.getManagedArtifactFile(
        artifact.artifactId,
        file: file,
        bundle: manifest.bundle
      )
      guard !Task.isCancelled, selectedPath == file.path else { return }
      contents[file.path] = data
    } catch {
      guard !Task.isCancelled, selectedPath == file.path else { return }
      fileError = error.localizedDescription
    }
  }
}

private enum ManagedHTMLPreviewMode: String, CaseIterable, Identifiable {
  case rendered
  case source

  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

func managedArtifactIsHTML(_ path: String) -> Bool {
  ["html", "htm"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
}

func managedSandboxedHTML(_ source: String) -> String {
  """
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; font: 15px -apple-system, BlinkMacSystemFont, sans-serif; }
      * { box-sizing: border-box; }
      body { max-width: 920px; margin: 0 auto; padding: 32px 38px 60px; line-height: 1.55; background: #fff; color: #242424; }
      h1, h2, h3, h4 { line-height: 1.2; margin: 1.4em 0 .55em; }
      h1:first-child, h2:first-child { margin-top: 0; }
      a { color: #0969da; }
      img, svg, video { max-width: 100%; height: auto; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 8px 10px; border: 1px solid #d0d7de; text-align: left; }
      th { background: #f6f8fa; }
      pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      pre { overflow: auto; padding: 14px; border-radius: 8px; background: #f6f8fa; }
      blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #d0d7de; color: #57606a; }
      @media (prefers-color-scheme: dark) {
        body { background: #1e1e1e; color: #e7e7e7; }
        a { color: #58a6ff; }
        th, td { border-color: #444; }
        th, pre { background: #292929; }
        blockquote { border-color: #555; color: #aaa; }
      }
    </style>
  </head>
  <body>
  \(source)
  </body>
  </html>
  """
}

private struct ManagedSandboxedHTMLView: NSViewRepresentable {
  let source: String

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {
    guard context.coordinator.loadedSource != source else { return }
    context.coordinator.loadedSource = source
    view.loadHTMLString(managedSandboxedHTML(source), baseURL: nil)
  }

  static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
    view.stopLoading()
    view.navigationDelegate = nil
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loadedSource: String?

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      guard navigationAction.navigationType == .other else { return .cancel }
      guard let url = navigationAction.request.url else { return .allow }
      return url.scheme == "about" ? .allow : .cancel
    }
  }
}

private func managedArtifactFileIcon(_ file: ManagedArtifactFile) -> String {
  switch managedArtifactPreviewKind(path: file.path, mediaType: file.mediaType) {
  case .markdown: "doc.richtext"
  case .text: managedArtifactIsHTML(file.path) ? "chevron.left.forwardslash.chevron.right" : "doc.text"
  case .image: "photo"
  case .unavailable: "doc"
  }
}

func managedArtifactDisplayText(_ data: Data, path: String) -> String? {
  if URL(fileURLWithPath: path).pathExtension.lowercased() == "json",
    let object = try? JSONSerialization.jsonObject(with: data),
    let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
  {
    return String(data: pretty, encoding: .utf8)
  }
  return String(data: data, encoding: .utf8)
}

private struct ManagedStateBadge: View {
  let state: String

  var body: some View {
    Text(managedStateLabel(state))
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .foregroundStyle(managedStateColor(state))
      .background(managedStateColor(state).opacity(0.12))
      .clipShape(Capsule())
  }
}
