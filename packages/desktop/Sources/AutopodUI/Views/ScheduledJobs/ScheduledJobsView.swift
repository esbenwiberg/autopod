import AutopodClient
import SwiftUI

/// Full-pane list of all scheduled jobs.
public struct ScheduledJobsView: View {
  public let jobs: [ScheduledJob]
  public var profileNames: [String]
  public var onRunCatchup: ((ScheduledJob) -> Void)?
  public var onSkipCatchup: ((ScheduledJob) -> Void)?
  public var onTriggerJob: ((ScheduledJob) -> Void)?
  public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?

  @State private var showCreateSheet = false

  public init(
    jobs: [ScheduledJob],
    profileNames: [String] = [],
    onRunCatchup: ((ScheduledJob) -> Void)? = nil,
    onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
    onTriggerJob: ((ScheduledJob) -> Void)? = nil,
    onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil
  ) {
    self.jobs = jobs
    self.profileNames = profileNames
    self.onRunCatchup = onRunCatchup
    self.onSkipCatchup = onSkipCatchup
    self.onTriggerJob = onTriggerJob
    self.onCreateJob = onCreateJob
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
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          showCreateSheet = true
        } label: {
          Image(systemName: "plus")
        }
        .help("New Scheduled Job")
      }
    }
    .sheet(isPresented: $showCreateSheet) {
      CreateScheduledJobSheet(
        isPresented: $showCreateSheet,
        profileNames: profileNames,
        onCreateJob: onCreateJob
      )
    }
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
      Button {
        showCreateSheet = true
      } label: {
        Label("New Scheduled Job", systemImage: "plus")
          .font(.caption)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
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
    jobs: [.previewCatchup, .previewActive, .previewDisabled],
    profileNames: ["my-app", "webapp"]
  )
  .frame(width: 600, height: 400)
}

#Preview("Scheduled Jobs — empty") {
  ScheduledJobsView(jobs: [], profileNames: ["my-app"])
    .frame(width: 600, height: 400)
}
