import AutopodClient
import SwiftUI

/// Full-pane list of scheduled jobs and reusable prompt templates.
public struct ScheduledJobsView: View {
  public let jobs: [ScheduledJob]
  public let templates: [ScheduledJobTemplate]
  public var profileNames: [String]
  public var onRunCatchup: ((ScheduledJob) -> Void)?
  public var onSkipCatchup: ((ScheduledJob) -> Void)?
  public var onTriggerJob: ((ScheduledJob) -> Void)?
  public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?
  public var onEditJob: ((String, UpdateScheduledJobRequest) -> Void)?
  public var onDeleteJob: ((ScheduledJob) -> Void)?
  public var onCreateTemplate: ((CreateScheduledJobTemplateRequest) -> Void)?
  public var onEditTemplate: ((String, UpdateScheduledJobTemplateRequest) -> Void)?
  public var onDeleteTemplate: ((ScheduledJobTemplate) -> Void)?

  @State private var showCreateSheet = false
  @State private var showCreateTemplateSheet = false
  @State private var jobToEdit: ScheduledJob?
  @State private var jobToDelete: ScheduledJob?
  @State private var templateToEdit: ScheduledJobTemplate?
  @State private var templateToDelete: ScheduledJobTemplate?
  @State private var searchText = ""
  @State private var selectedProfileFilter = "__all"

  private static let allProfiles = "__all"
  private static let allProfilesLabel = "All Profiles"

  public init(
    jobs: [ScheduledJob],
    templates: [ScheduledJobTemplate] = [],
    profileNames: [String] = [],
    onRunCatchup: ((ScheduledJob) -> Void)? = nil,
    onSkipCatchup: ((ScheduledJob) -> Void)? = nil,
    onTriggerJob: ((ScheduledJob) -> Void)? = nil,
    onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil,
    onEditJob: ((String, UpdateScheduledJobRequest) -> Void)? = nil,
    onDeleteJob: ((ScheduledJob) -> Void)? = nil,
    onCreateTemplate: ((CreateScheduledJobTemplateRequest) -> Void)? = nil,
    onEditTemplate: ((String, UpdateScheduledJobTemplateRequest) -> Void)? = nil,
    onDeleteTemplate: ((ScheduledJobTemplate) -> Void)? = nil
  ) {
    self.jobs = jobs
    self.templates = templates
    self.profileNames = profileNames
    self.onRunCatchup = onRunCatchup
    self.onSkipCatchup = onSkipCatchup
    self.onTriggerJob = onTriggerJob
    self.onCreateJob = onCreateJob
    self.onEditJob = onEditJob
    self.onDeleteJob = onDeleteJob
    self.onCreateTemplate = onCreateTemplate
    self.onEditTemplate = onEditTemplate
    self.onDeleteTemplate = onDeleteTemplate
  }

  private var profiles: [String] { profileNames.sorted() }

  private var profileFilteredJobs: [ScheduledJob] {
    if selectedProfileFilter == Self.allProfiles { return jobs }
    return jobs.filter { $0.profileName == selectedProfileFilter }
  }

  private var filteredJobs: [ScheduledJob] {
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return profileFilteredJobs }
    return profileFilteredJobs.filter { job in
      job.name.lowercased().contains(q)
        || job.templateName.lowercased().contains(q)
        || job.profileName.lowercased().contains(q)
        || job.cronExpression.lowercased().contains(q)
    }
  }

  private var filteredTemplates: [ScheduledJobTemplate] {
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return templates.filter { template in
      let linkedJobs = profileFilteredJobs.filter { $0.templateId == template.id }
      let matchesProfile = selectedProfileFilter == Self.allProfiles || !linkedJobs.isEmpty
      let matchesSearch = q.isEmpty
        || template.name.lowercased().contains(q)
        || template.prompt.lowercased().contains(q)
        || linkedJobs.contains { $0.name.lowercased().contains(q) }
      return matchesProfile && matchesSearch
    }
  }

  private var pendingJobs: [ScheduledJob] { filteredJobs.filter { $0.catchupPending } }
  private var otherJobs: [ScheduledJob] { filteredJobs.filter { !$0.catchupPending } }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      toolbar
      Divider()

      if jobs.isEmpty && templates.isEmpty {
        emptyState
      } else {
        HSplitView {
          templatePane
            .frame(minWidth: 220, idealWidth: 260)
          jobPane
            .frame(minWidth: 360)
        }
      }
    }
    .sheet(isPresented: $showCreateSheet) {
      CreateScheduledJobSheet(
        isPresented: $showCreateSheet,
        templates: templates,
        profileNames: profileNames,
        onCreateJob: onCreateJob
      )
    }
    .sheet(isPresented: $showCreateTemplateSheet) {
      ScheduledJobTemplateSheet(
        isPresented: $showCreateTemplateSheet,
        onSave: { request in onCreateTemplate?(request) }
      )
    }
    .sheet(item: $jobToEdit) { job in
      EditScheduledJobSheet(
        isPresented: Binding(
          get: { jobToEdit != nil },
          set: { if !$0 { jobToEdit = nil } }
        ),
        job: job,
        templates: templates,
        profileNames: profileNames,
        onEditJob: onEditJob
      )
    }
    .sheet(item: $templateToEdit) { template in
      ScheduledJobTemplateSheet(
        isPresented: Binding(
          get: { templateToEdit != nil },
          set: { if !$0 { templateToEdit = nil } }
        ),
        template: template,
        onSave: { request in
          onEditTemplate?(template.id, UpdateScheduledJobTemplateRequest(
            name: request.name,
            prompt: request.prompt
          ))
        }
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
    .alert(
      "Delete template \"\(templateToDelete?.name ?? "")\"?",
      isPresented: Binding(
        get: { templateToDelete != nil },
        set: { if !$0 { templateToDelete = nil } }
      )
    ) {
      Button("Delete", role: .destructive) {
        if let template = templateToDelete { onDeleteTemplate?(template) }
        templateToDelete = nil
      }
      Button("Cancel", role: .cancel) { templateToDelete = nil }
    } message: {
      Text("Templates with linked scheduled jobs cannot be deleted.")
    }
  }

  private var header: some View {
    HStack {
      Text("Scheduled Jobs")
        .font(.headline)
      Spacer()
      Button {
        showCreateTemplateSheet = true
      } label: {
        Label("New Template", systemImage: "doc.badge.plus")
          .font(.caption)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)

      Button {
        showCreateSheet = true
      } label: {
        Label("New Job", systemImage: "plus")
          .font(.caption)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .disabled(templates.isEmpty)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private var toolbar: some View {
    HStack(spacing: 10) {
      searchField
      Picker("Profile", selection: $selectedProfileFilter) {
        Text(Self.allProfilesLabel).tag(Self.allProfiles)
        ForEach(profiles, id: \.self) { profile in
          Text(profile).tag(profile)
        }
      }
      .labelsHidden()
      .frame(width: 180)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private var searchField: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
        .font(.caption)
        .foregroundStyle(.secondary)
      TextField("Search jobs or templates", text: $searchText)
        .textFieldStyle(.plain)
        .font(.callout)
      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .help("Clear search")
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 6))
  }

  private var templatePane: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Templates")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
      Divider()
      List {
        if filteredTemplates.isEmpty {
          Text("No templates")
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.vertical, 8)
        } else {
          ForEach(filteredTemplates) { template in
            templateRow(template)
              .contextMenu {
                Button("Edit") { templateToEdit = template }
                Button("Delete", role: .destructive) { templateToDelete = template }
              }
          }
        }
      }
      .listStyle(.inset)
    }
  }

  private func templateRow(_ template: ScheduledJobTemplate) -> some View {
    let count = profileFilteredJobs.filter { $0.templateId == template.id }.count
    return HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(template.name)
          .font(.system(.callout).weight(.semibold))
          .lineLimit(1)
        Text("\(count) job\(count == 1 ? "" : "s")")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
    .padding(.vertical, 3)
  }

  private var jobPane: some View {
    List {
      if !pendingJobs.isEmpty {
        Section {
          ForEach(pendingJobs) { job in
            jobRow(job)
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
            jobRow(job)
          }
        }
      }

      if pendingJobs.isEmpty && otherJobs.isEmpty {
        Text("No matching jobs")
          .foregroundStyle(.secondary)
          .padding(.vertical, 8)
      }
    }
    .listStyle(.inset)
  }

  private func jobRow(_ job: ScheduledJob) -> some View {
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

  private var emptyState: some View {
    VStack(spacing: 12) {
      Image(systemName: "clock.badge.checkmark")
        .font(.system(size: 40))
        .foregroundStyle(.tertiary)
      Text("No scheduled jobs")
        .font(.title3)
        .foregroundStyle(.secondary)
      Button("New Template") {
        showCreateTemplateSheet = true
      }
      .buttonStyle(.bordered)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

#Preview("Scheduled Jobs — populated") {
  ScheduledJobsView(
    jobs: [.previewCatchup, .previewActive, .previewDisabled],
    templates: [.previewLogTriage, .previewGarbageCleanup],
    profileNames: ["my-app", "webapp"]
  )
  .frame(width: 760, height: 440)
}

#Preview("Scheduled Jobs — empty") {
  ScheduledJobsView(jobs: [], templates: [], profileNames: ["my-app"])
    .frame(width: 600, height: 400)
}
