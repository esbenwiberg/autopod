import AutopodClient
import SwiftUI

/// Full-pane list of all scheduled jobs.
public struct ScheduledJobsView: View {
  public let jobs: [ScheduledJob]
  public var onRunCatchup: ((ScheduledJob) -> Void)?
  public var onSkipCatchup: ((ScheduledJob) -> Void)?
  public var onTriggerJob: ((ScheduledJob) -> Void)?

  public init(
    jobs: [ScheduledJob],
    onRunCatchup: ((ScheduledJob) -> Void)? = nil,
    onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
    onTriggerJob: ((ScheduledJob) -> Void)? = nil
  ) {
    self.jobs = jobs
    self.onRunCatchup = onRunCatchup
    self.onSkipCatchup = onSkipCatchup
    self.onTriggerJob = onTriggerJob
  }

  private var pendingJobs: [ScheduledJob] { jobs.filter { $0.catchupPending } }
  private var otherJobs: [ScheduledJob] { jobs.filter { !$0.catchupPending } }

  public var body: some View {
    Group {
      if jobs.isEmpty {
        emptyState
      } else {
        jobList
      }
    }
    .navigationTitle("Scheduled Jobs")
  }

  // MARK: - Empty state

  private var emptyState: some View {
    VStack(spacing: 12) {
      Image(systemName: "clock.badge.checkmark")
        .font(.system(size: 40))
        .foregroundStyle(.tertiary)
      Text("No scheduled jobs")
        .font(.title3)
        .foregroundStyle(.secondary)
      Text("Use `ap schedule create` to add a scheduled job.")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Job list

  private var jobList: some View {
    List {
      if !pendingJobs.isEmpty {
        Section {
          ForEach(pendingJobs) { job in
            ScheduledJobRow(
              job: job,
              onRunCatchup: onRunCatchup,
              onSkipCatchup: onSkipCatchup
            )
          }
        } header: {
          Label("Needs Attention", systemImage: "exclamationmark.circle.fill")
            .foregroundStyle(.orange)
            .font(.caption.weight(.semibold))
        }
      }

      if !otherJobs.isEmpty {
        Section("All Jobs") {
          ForEach(otherJobs) { job in
            ScheduledJobRow(
              job: job,
              onRunCatchup: onRunCatchup,
              onSkipCatchup: onSkipCatchup
            )
            .contextMenu {
              Button("Run Now") { onTriggerJob?(job) }
            }
          }
        }
      }
    }
    .listStyle(.inset)
  }
}

// MARK: - Preview

#Preview("Scheduled Jobs — populated") {
  ScheduledJobsView(
    jobs: [.previewCatchup, .previewActive, .previewDisabled]
  )
  .frame(width: 600, height: 400)
}

#Preview("Scheduled Jobs — empty") {
  ScheduledJobsView(jobs: [])
    .frame(width: 600, height: 400)
}
