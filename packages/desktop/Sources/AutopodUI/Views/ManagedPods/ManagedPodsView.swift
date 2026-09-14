import AutopodClient
import Foundation
import SwiftUI
import AppKit

public struct ManagedPodsView: View {
  public let pods: [ManagedPodSummary]
  @Binding public var selection: String?
  public let isLoading: Bool
  public let error: String?
  public let onRefresh: () async -> Void

  public init(
    pods: [ManagedPodSummary],
    selection: Binding<String?>,
    isLoading: Bool,
    error: String?,
    onRefresh: @escaping () async -> Void
  ) {
    self.pods = pods
    self._selection = selection
    self.isLoading = isLoading
    self.error = error
    self.onRefresh = onRefresh
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Managed Pods")
            .font(.title2.weight(.semibold))
          Text("Read-only Dispatcher attempts")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if isLoading { ProgressView().controlSize(.small) }
        Button {
          Task { await onRefresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .help("Refresh managed pods")
      }
      .padding(16)

      if let error {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
          .padding(.bottom, 10)
      }

      Divider()

      if pods.isEmpty && !isLoading {
        ContentUnavailableView(
          "No Managed Pods",
          systemImage: "shippingbox",
          description: Text("No managed attempts are visible for this enrolled installation.")
        )
      } else {
        Table(pods, selection: $selection) {
          TableColumn("State") { pod in
            ManagedStateBadge(state: pod.state)
          }
          .width(min: 90, ideal: 110)

          TableColumn("Managed Pod") { pod in
            Text(pod.podId)
              .font(.system(.caption, design: .monospaced))
              .lineLimit(1)
          }
          .width(min: 170, ideal: 230)

          TableColumn("Validation") { pod in
            Text(managedValidationLabel(pod.validationStatus))
              .font(.caption)
          }.width(min: 100, ideal: 140)

          TableColumn("Model") { pod in
            VStack(alignment: .leading, spacing: 1) {
              Text(pod.model).lineLimit(1)
              Text(pod.providerAccountId)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          .width(min: 110, ideal: 150)

          TableColumn("Requests") { pod in
            Text(pod.providerRequests.formatted())
              .monospacedDigit()
          }
          .width(70)

          TableColumn("Observed tokens") { pod in
            HStack(spacing: 4) {
              Text(pod.consumedTokens.formatted())
                .monospacedDigit()
              if !pod.tokenUsageKnown {
                Image(systemName: "questionmark.circle")
                  .foregroundStyle(.secondary)
                  .help("Some request usage is unknown")
              }
            }
          }
          .width(min: 105, ideal: 120)

          TableColumn("Last event") { pod in
            Text(pod.lastEventDate, style: .relative)
              .foregroundStyle(.secondary)
          }
          .width(min: 90, ideal: 110)
        }
      }
    }
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
}

public struct ManagedPodDetailView: View {
  private let initialPod: ManagedPodSummary
  public var pod: ManagedPodSummary { detail?.pod.podId == initialPod.podId ? detail!.pod : initialPod }
  public let api: DaemonAPI?
  @State private var detail: ManagedPodDetailResponse?
  @State private var detailError: String?

  public init(pod: ManagedPodSummary, api: DaemonAPI? = nil) {
    self.initialPod = pod
    self.api = api
  }

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack {
          ManagedStateBadge(state: pod.state)
          Spacer()
          Text(pod.lastEventDate, style: .relative)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        detailSection("Identity") {
          detailRow("Managed pod", pod.podId, monospaced: true)
          detailRow("Dispatcher attempt", pod.dispatcherAttemptId, monospaced: true)
          detailRow("Profile", "\(pod.profileId) v\(pod.profileVersion)")
        }

        detailSection("Route") {
          detailRow("Provider account", pod.providerAccountId)
          detailRow("Model", pod.model)
          detailRow("Runtime", pod.runtime)
          detailRow("Target", pod.executionTarget)
          detailRow("Reasoning", pod.reasoning)
        }

        detailSection("AutoPod validation") {
          Text(managedValidationLabel(detail?.pod.validationStatus ?? pod.validationStatus))
          ForEach(detail?.validations ?? []) { run in
            detailRow("Mode", run.mode)
            detailRow("Checked commit", run.newCommit, monospaced: true)
            if !run.reason.isEmpty { Text(run.reason).font(.caption).foregroundStyle(.secondary) }
            ForEach(run.phases) { phase in
              HStack {
                Text(phase.phase.capitalized)
                Spacer()
                Text(phase.status)
                Text(String(format: "%.1fs", Double(phase.durationMs) / 1000))
              }.font(.caption)
            }
          }
        }

        detailSection("Source delivery") {
          detailRow("Dispatcher verification", detail?.verification?.status ?? "Not received")
          ForEach(detail?.candidates ?? []) { candidate in
            detailRow("Candidate commit", candidate.newCommit, monospaced: true)
          }
          ForEach(detail?.source ?? []) { receipt in
            detailRow(receipt.operation, receipt.status)
            detailRow("Branch", receipt.head, monospaced: true)
            if receipt.pullRequestId > 0 { detailRow("Draft PR", "#\(receipt.pullRequestId)") }
          }
        }
        if let detailError { Text(detailError).font(.caption).foregroundStyle(.orange) }

        detailSection("Runtime evidence") {
          detailRow("Provider requests", pod.providerRequests.formatted())
          detailRow(
            "Observed tokens",
            pod.tokenUsageKnown
              ? pod.consumedTokens.formatted()
              : "\(pod.consumedTokens.formatted()) (incomplete)"
          )
          detailRow("Observed exit", pod.observedExit ? "Yes" : "No")
          detailRow("Exit code", pod.exitCode.map(String.init) ?? "—")
          detailRow("Cleanup", pod.cleanup)
          detailRow("Revoked", pod.revoked ? "Yes" : "No")
          detailRow("Stop requested", pod.stopRequested ? "Yes" : "No")
        }

        if let failure = pod.failure {
          detailSection("Latest provider failure") {
            detailRow("Phase", failure.phase)
            detailRow("Reason", failure.reason)
            detailRow("HTTP status", failure.httpStatus.map(String.init) ?? "—")
          }
        }

        if !pod.limitations.isEmpty {
          detailSection("Limitations") {
            ForEach(pod.limitations, id: \.self) { limitation in
              Label(limitation, systemImage: "exclamationmark.circle")
                .font(.caption)
            }
          }
        }

        detailSection("Artifacts") {
          if pod.artifacts.isEmpty {
            Text("No committed or pending artifacts")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            ForEach(detail?.pod.artifacts ?? pod.artifacts) { artifact in
              VStack(alignment: .leading, spacing: 3) {
                Text(artifact.artifactId)
                  .font(.system(.caption, design: .monospaced))
                  .textSelection(.enabled)
                Text("\(artifact.status) · \(artifact.fileCount) files · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.totalBytes), countStyle: .file))")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                if artifact.status == "committed", let api {
                  ManagedArtifactInspector(artifact: artifact, api: api)
                }
              }
            }
          }
        }
        detailSection("Timeline") {
          ForEach(detail?.events ?? []) { event in
            HStack {
              Text(Date(timeIntervalSince1970: TimeInterval(event.createdAt)), style: .time)
              Text(event.kind.replacingOccurrences(of: "_", with: " "))
            }.font(.caption)
          }
        }
      }
      .padding(18)
    }
    .task(id: pod.podId) {
      detail = nil
      detailError = nil
      guard let api else { return }
      while !Task.isCancelled {
        do {
          let fetched = try await api.getManagedPod(pod.podId)
          guard !Task.isCancelled else { return }
          detail = fetched
          detailError = nil
        } catch { if !Task.isCancelled { detailError = error.localizedDescription } }
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
  }

  @ViewBuilder
  private func detailSection<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased())
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
  }

  private func detailRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption2)
        .foregroundStyle(.tertiary)
      Text(value)
        .font(monospaced ? .system(.caption, design: .monospaced) : .caption)
        .textSelection(.enabled)
    }
  }
}

private func managedValidationLabel(_ status: String?) -> String {
  if status == "disabled" { return "Disabled by configuration" }
  return (status ?? "not requested").replacingOccurrences(of: "-", with: " ").capitalized
}

private struct ManagedArtifactInspector: View {
  let artifact: ManagedArtifactSummary
  let api: DaemonAPI
  @State private var manifest: ManagedArtifactManifest?
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Button("View manifest") {
          Task { @MainActor in
            busy = true
            defer { busy = false }
            do { manifest = try await api.getManagedArtifactManifest(artifact.artifactId); error = nil }
            catch { self.error = error.localizedDescription }
          }
        }
        Button("Download") {
          Task { @MainActor in
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "\(artifact.artifactId).tar.gz"
            guard await panel.begin() == .OK, let url = panel.url else { return }
            busy = true
            defer { busy = false }
            do { let data = try await api.downloadManagedArtifact(artifact.artifactId); try data.write(to: url, options: .atomic); error = nil }
            catch { self.error = error.localizedDescription }
          }
        }
      }.disabled(busy)
      if let error { Text(error).font(.caption).foregroundStyle(.orange) }
      if let manifest {
        Text(manifest.bundle.sha256).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
        ForEach(manifest.files) { file in
          Text("\(file.path) · \(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))")
            .font(.caption).textSelection(.enabled)
        }
      }
    }
  }
}

private struct ManagedStateBadge: View {
  let state: String

  var body: some View {
    Text(state.replacingOccurrences(of: "_", with: " ").capitalized)
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .foregroundStyle(color)
      .background(color.opacity(0.12))
      .clipShape(Capsule())
  }

  private var color: Color {
    switch state {
    case "running", "validating": .blue
    case "validated", "complete": .green
    case "review_required": .orange
    case "failed", "killed": .red
    default: .secondary
    }
  }
}
