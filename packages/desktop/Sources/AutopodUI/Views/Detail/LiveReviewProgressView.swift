import SwiftUI

public struct LiveReviewProgressPresentation: Equatable, Sendable {
  public let headline: String
  public let timing: String
  public let next: String
}
public func liveReviewProgressPresentation(
  _ progress: LiveReviewProgress,
  at date: Date = Date()
) -> LiveReviewProgressPresentation {
  let next = switch progress.stage {
  case .axes: "Next: synthesis → closure when needed → finalizing"
  case .synthesis: "Synthesizing canonical findings"
  case .closure: "Verifying prior findings against the repair delta"
  case .finalizing: "Assembling the final Review verdict"
  }
  return LiveReviewProgressPresentation(
    headline: "\(progress.settledCount)/\(progress.axes.count) settled",
    timing: progress.timeLabel(at: date),
    next: next
  )
}

struct LiveReviewProgressView: View {
  let progress: LiveReviewProgress

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let presentation = liveReviewProgressPresentation(progress, at: context.date)
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .firstTextBaseline) {
          Label("Review Council", systemImage: "person.3.fill")
            .font(.headline)
          Spacer()
          Text(progress.stage == .axes ? "Running" : progress.stage.displayName)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.blue)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.blue.opacity(0.12), in: Capsule())
        }

        HStack(spacing: 6) {
          Text(presentation.headline)
          Text("·")
          Text(presentation.timing)
        }
        .font(.caption)
        .foregroundStyle(.secondary)

        LazyVGrid(
          columns: [GridItem(.adaptive(minimum: 145), spacing: 8)],
          spacing: 8
        ) {
          ForEach(progress.axes) { axis in
            axisCard(axis)
          }
        }

        Label(presentation.next, systemImage: stageIcon)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(12)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .accessibilityElement(children: .contain)
      .accessibilityLabel(
        "Review Council, \(presentation.headline), \(presentation.timing), \(progress.stage.displayName)"
      )
    }
  }

  private func axisCard(_ axis: LiveReviewAxis) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Label(axis.displayName, systemImage: axisIcon(axis.status))
        .font(.caption.weight(.semibold))
        .foregroundStyle(axisColor(axis.status))
      Text(axisStatus(axis))
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(8)
    .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(axis.displayName): \(axisStatus(axis))")
  }

  private func axisStatus(_ axis: LiveReviewAxis) -> String {
    switch axis.status {
    case .queued: "Queued"
    case .running: "Running · attempt \(max(1, axis.attempt))"
    case .completed: axis.durationMs.map { "Completed · \(duration($0))" } ?? "Completed"
    case .unavailable:
      "Unavailable · \(axis.attempt) attempt\(axis.attempt == 1 ? "" : "s")"
    }
  }

  private func axisIcon(_ status: LiveReviewAxisStatus) -> String {
    switch status {
    case .queued: "circle.dashed"
    case .running: "clock.fill"
    case .completed: "checkmark.circle.fill"
    case .unavailable: "exclamationmark.triangle.fill"
    }
  }

  private func axisColor(_ status: LiveReviewAxisStatus) -> Color {
    switch status {
    case .queued: .secondary
    case .running: .blue
    case .completed: .green
    case .unavailable: .orange
    }
  }

  private var stageIcon: String {
    switch progress.stage {
    case .axes: "arrow.right.circle"
    case .synthesis: "arrow.triangle.branch"
    case .closure: "checkmark.shield"
    case .finalizing: "checkmark.seal"
    }
  }

  private func duration(_ milliseconds: Int) -> String {
    let seconds = max(0, milliseconds / 1_000)
    return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
  }
}
