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
  public var onEditJob: ((String, UpdateScheduledJobRequest) -> Void)?
  public var onDeleteJob: ((ScheduledJob) -> Void)?

  @State private var showCreateSheet = false
  @State private var jobToEdit: ScheduledJob?
  @State private var jobToDelete: ScheduledJob?

  public init(
    jobs: [ScheduledJob],
    profileNames: [String] = [],
    onRunCatchup: ((ScheduledJob) -> Void)? = nil,
    onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
    onTriggerJob: ((ScheduledJob) -> Void)? = nil,
    onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil,
    onEditJob: ((String, UpdateScheduledJobRequest) -> Void)? = nil,
    onDeleteJob: ((ScheduledJob) -> Void)? = nil
  ) {
    self.jobs = jobs
    self.profileNames = profileNames
    self.onRunCatchup = onRunCatchup
    self.onSkipCatchup = onSkipCatchup
    self.onTriggerJob = onTriggerJob
    self.onCreateJob = onCreateJob
    self.onEditJob = onEditJob
    self.onDeleteJob = onDeleteJob
  }

  private var pendingJobs: [ScheduledJob] { jobs.filter { $0.catchupPending } }
  private var otherJobs: [ScheduledJob] { jobs.filter { !$0.catchupPending } }

  public var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Scheduled Jobs")
          .font(.headline)
        Spacer()
        Button {
          showCreateSheet = true
        } label: {
          Label("Add", systemImage: "plus")
            .font(.caption)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)

      Divider()

      if jobs.isEmpty {
        emptyState
      } else {
        jobList
      }
    }
    .sheet(isPresented: $showCreateSheet) {
      CreateScheduledJobSheet(
        isPresented: $showCreateSheet,
        profileNames: profileNames,
        onCreateJob: onCreateJob
      )
    }
    .sheet(item: $jobToEdit) { job in
      EditScheduledJobSheet(
        isPresented: Binding(
          get: { jobToEdit != nil },
          set: { if !$0 { jobToEdit = nil } }
        ),
        job: job,
        onEditJob: onEditJob
      )
    }
    .alert(
      "Delete \"\(jobToDelete?.name ?? "")\"?",
      isPresented: Binding(get: { jobToDelete != nil }, set: { if !$0 { jobToDelete = nil } })
    ) {
      Button("Delete", role: .destructive) {
        if let job = jobToDelete { onDeleteJob?(job) }
        jobToDelete = nil
      }
      Button("Cancel", role: .cancel) { jobToDelete = nil }
    } message: {
      Text("This scheduled job will be permanently removed.")
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
            .contextMenu {
              Button("Run Now") { onTriggerJob?(job) }
              Divider()
              Button("Edit") { jobToEdit = job }
              Button("Delete", role: .destructive) { jobToDelete = job }
            }
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
              Divider()
              Button("Edit") { jobToEdit = job }
              Button("Delete", role: .destructive) { jobToDelete = job }
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
