import AutopodClient
import Foundation
import SwiftUI

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
  public let pod: ManagedPodSummary

  public init(pod: ManagedPodSummary) {
    self.pod = pod
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
            ForEach(pod.artifacts) { artifact in
              VStack(alignment: .leading, spacing: 3) {
                Text(artifact.artifactId)
                  .font(.system(.caption, design: .monospaced))
                  .textSelection(.enabled)
                Text("\(artifact.status) · \(artifact.fileCount) files · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.totalBytes), countStyle: .file))")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
      .padding(18)
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
