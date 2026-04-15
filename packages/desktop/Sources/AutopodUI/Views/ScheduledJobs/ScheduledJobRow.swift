import AutopodClient
import SwiftUI

/// A single row in the Scheduled Jobs list.
public struct ScheduledJobRow: View {
  public let job: ScheduledJob
  public var onRunCatchup: ((ScheduledJob) -> Void)?
  public var onSkipCatchup: ((ScheduledJob) -> Void)?

  public init(
    job: ScheduledJob,
    onRunCatchup: ((ScheduledJob) -> Void)? = nil,
    onSkipCatchup: ((ScheduledJob) -> Void)? = nil
  ) {
    self.job = job
    self.onRunCatchup = onRunCatchup
    self.onSkipCatchup = onSkipCatchup
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text(job.name)
          .font(.system(.body).weight(.semibold))
          .lineLimit(1)
        Spacer()
        statusPill
      }

      HStack(spacing: 6) {
        Text(job.profileName)
          .font(.caption)
          .foregroundStyle(.secondary)
        Text("·")
          .foregroundStyle(.tertiary)
        Text(job.cronExpression)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
        Spacer()
        Text(nextRunLabel)
          .font(.caption)
          .foregroundStyle(nextRunColor)
      }

      if job.catchupPending {
        HStack(spacing: 8) {
          Text("Missed run — action required")
            .font(.caption)
            .foregroundStyle(.orange)
          Spacer()
          Button("Run Now") { onRunCatchup?(job) }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(.orange)
          Button("Skip") { onSkipCatchup?(job) }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.top, 2)
      }
    }
    .padding(.vertical, 4)
    .contentShape(Rectangle())
  }

  // MARK: - Status pill

  private var statusPill: some View {
    Group {
      if job.catchupPending {
        Text("catch-up pending")
          .foregroundStyle(.orange)
          .background(Color.orange.opacity(0.12))
      } else if !job.enabled {
        Text("disabled")
          .foregroundStyle(.secondary)
          .background(Color.secondary.opacity(0.1))
      } else {
        Text("active")
          .foregroundStyle(.green)
          .background(Color.green.opacity(0.1))
      }
    }
    .font(.system(.caption2).weight(.semibold))
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .clipShape(Capsule())
  }

  // MARK: - Next run label

  private var nextRunLabel: String {
    let diff = ISO8601DateFormatter().date(from: job.nextRunAt).map {
      $0.timeIntervalSinceNow
    } ?? 0
    if diff < 0 { return "overdue" }
    let minutes = Int(diff / 60)
    let hours = minutes / 60
    let days = hours / 24
    if days > 0 { return "in \(days)d \(hours % 24)h" }
    if hours > 0 { return "in \(hours)h \(minutes % 60)m" }
    return "in \(minutes)m"
  }

  private var nextRunColor: Color {
    let diff = ISO8601DateFormatter().date(from: job.nextRunAt).map {
      $0.timeIntervalSinceNow
    } ?? 0
    return diff < 0 ? .red : .secondary
  }
}

// MARK: - Preview

#Preview {
  VStack {
    ScheduledJobRow(job: .previewActive)
    Divider()
    ScheduledJobRow(job: .previewCatchup)
    Divider()
    ScheduledJobRow(job: .previewDisabled)
  }
  .padding()
  .frame(width: 500)
}

extension ScheduledJob {
  static var previewActive: ScheduledJob {
    ScheduledJob(
      id: "abc123",
      name: "Daily build check",
      profileName: "my-app",
      task: "Run the full test suite",
      cronExpression: "0 9 * * *",
      enabled: true,
      nextRunAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
      lastRunAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400)),
      lastSessionId: nil,
      catchupPending: false,
      createdAt: ISO8601DateFormatter().string(from: Date()),
      updatedAt: ISO8601DateFormatter().string(from: Date())
    )
  }

  static var previewCatchup: ScheduledJob {
    ScheduledJob(
      id: "def456",
      name: "Weekly report",
      profileName: "webapp",
      task: "Generate weekly report",
      cronExpression: "0 8 * * 1",
      enabled: true,
      nextRunAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
      lastRunAt: nil,
      lastSessionId: nil,
      catchupPending: true,
      createdAt: ISO8601DateFormatter().string(from: Date()),
      updatedAt: ISO8601DateFormatter().string(from: Date())
    )
  }

  static var previewDisabled: ScheduledJob {
    ScheduledJob(
      id: "ghi789",
      name: "Nightly cleanup",
      profileName: "backend",
      task: "Clean temp files",
      cronExpression: "0 2 * * *",
      enabled: false,
      nextRunAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(7200)),
      lastRunAt: nil,
      lastSessionId: nil,
      catchupPending: false,
      createdAt: ISO8601DateFormatter().string(from: Date()),
      updatedAt: ISO8601DateFormatter().string(from: Date())
    )
  }
}
