import AutopodClient
import SwiftUI

/// Dedicated redesigned workspace. Legacy schedules retain their original view.
public struct DesktopSchedulesView: View {
  public let jobs: [ScheduledJob]
  public let templates: [ScheduledJobTemplate]
  public let profiles: [String]
  public let configuration: LaunchConfigurationActions?
  public let actions: ScheduledWorkspaceActions
  public let openReports: (ScheduledJob) -> Void
  public let openPod: (String) -> Void
  public var onDirty: (Bool) -> Void
  public var onBusy: (Bool) -> Void
  @State private var tab = "Schedules"
  @State private var selectedID: String?
  @State private var query = ""
  @State private var repository = ""
  @State private var profile = ""
  @State private var state = "All states"
  @State private var editingJob = false
  @State private var editorArea = "Schedule"
  @State private var jobToEdit: ScheduledJob?
  @State private var editingTemplate = false
  @State private var templateToEdit: ScheduledJobTemplate?
  @State private var newTemplateID: String?
  @State private var dirty = false
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var pendingNavigation: (() -> Void)?
  @State private var discard = false
  @State private var jobToDelete: ScheduledJob?
  @State private var templateToDelete: ScheduledJobTemplate?
  @State private var jobToRun: ScheduledJob?
  @State private var catchupRun = false

  public init(jobs: [ScheduledJob], templates: [ScheduledJobTemplate], profiles: [String],
    configuration: LaunchConfigurationActions?, actions: ScheduledWorkspaceActions,
    openReports: @escaping (ScheduledJob) -> Void, openPod: @escaping (String) -> Void,
    onDirty: @escaping (Bool) -> Void = { _ in }, onBusy: @escaping (Bool) -> Void = { _ in }, initialTab: String = "Schedules") {
    self.jobs = jobs; self.templates = templates; self.profiles = profiles
    self.configuration = configuration; self.actions = actions
    self.openReports = openReports; self.openPod = openPod; self.onDirty = onDirty; self.onBusy = onBusy
    _tab = State(initialValue: initialTab)
  }
  private func repoID(_ job: ScheduledJob) -> String { job.launch?["repositoryId"]?.string ?? "" }
  private func repoName(_ job: ScheduledJob) -> String {
    if let id = job.launch?["repositoryId"]?.string {
      return configuration?.list(.repository).first { $0.id == id }?.name ?? "Repository unavailable (\(id))"
    }
    return job.launch?["emptyWorkspace"]?.bool == true ? "Empty workspace" : "Legacy configuration"
  }
  private func profileName(_ job: ScheduledJob) -> String {
    if let legacy = job.profileName { return legacy }
    let repo = configuration?.list(.repository).first { $0.id == repoID(job) }
    let id = job.launch?["profileId"]?.string ?? repo?.payload["usualProfileId"]?.string
    return configuration?.list(.profile).first { $0.id == id }?.name ?? "Configuration"
  }
  private var filtered: [ScheduledJob] {
    jobs.filter { job in
      (repository.isEmpty || repoID(job) == repository)
      && (profile.isEmpty || profileName(job) == profile)
      && (state == "All states" || (state == "Needs attention" ? job.catchupPending : state == "Active" ? job.enabled : !job.enabled))
      && (query.isEmpty || [job.name, job.templateName, repoName(job), profileName(job), job.cronExpression].joined(separator: " ").localizedCaseInsensitiveContains(query))
    }
  }
  private var selected: ScheduledJob? { filtered.first { $0.id == selectedID } }
  public var body: some View {
    Group {
      if editingJob {
        DesktopScheduleEditor(job: jobToEdit, templates: templates, profiles: profiles,
          configuration: configuration, actions: actions, templateID: newTemplateID, initialArea: editorArea,
          onClose: { navigate { editingJob = false } }, onDirty: setDirty, onBusy: setBusy)
      } else if editingTemplate {
        ScheduledJobTemplateSheet(
          isPresented: Binding(get: { editingTemplate }, set: { value in if !value { navigate { editingTemplate = false } } }),
          template: templateToEdit, embedded: true,
          saveAwaited: { request in
            if let templateToEdit {
              try await actions.updateTemplate(templateToEdit.id, UpdateScheduledJobTemplateRequest(name: request.name, prompt: request.prompt, fields: request.fields))
            } else { try await actions.createTemplate(request) }
          }, onDirtyChanged: setDirty, onBusyChanged: setBusy,
          linkedScheduleNames: jobs.filter { $0.templateId == templateToEdit?.id }.map(\.name))
      } else { library }
    }
    .background(DesktopTheme.surface)
    .onAppear { if selectedID == nil { selectedID = jobs.first(where: \.catchupPending)?.id ?? jobs.first?.id } }
    .confirmationDialog("Discard unsaved schedule changes?", isPresented: $discard) {
      Button("Discard changes", role: .destructive) { setDirty(false); let next = pendingNavigation; pendingNavigation = nil; next?() }
      Button("Keep editing", role: .cancel) { pendingNavigation = nil }
    }
    .alert("Run \(jobToRun?.name ?? "schedule") now?", isPresented: Binding(get: { jobToRun != nil }, set: { if !$0 { jobToRun = nil } })) {
      Button("Run now") { if let jobToRun { let job = jobToRun; let catchup = catchupRun; self.jobToRun = nil; perform { notice = try await actions.run(job, catchup) } } }
      Button("Cancel", role: .cancel) { jobToRun = nil }
    } message: { Text("This uses the schedule’s saved repository and launch choices.") }
    .alert("Delete schedule?", isPresented: Binding(get: { jobToDelete != nil }, set: { if !$0 { jobToDelete = nil } })) {
      Button("Delete", role: .destructive) { if let jobToDelete { let job = jobToDelete; self.jobToDelete = nil; perform { try await actions.delete(job) } } }
      Button("Cancel", role: .cancel) { jobToDelete = nil }
    } message: { Text("\(jobToDelete?.name ?? "This schedule") will be permanently removed.") }
    .alert("Delete template?", isPresented: Binding(get: { templateToDelete != nil }, set: { if !$0 { templateToDelete = nil } })) {
      Button("Delete", role: .destructive) { if let templateToDelete { let template = templateToDelete; self.templateToDelete = nil; perform { try await actions.deleteTemplate(template) } } }
      Button("Cancel", role: .cancel) { templateToDelete = nil }
    } message: { Text("Templates with linked schedules cannot be deleted.") }
  }
  private var library: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 7) {
          Text("WORKSPACE").font(.caption2).foregroundStyle(.secondary)
          Text("Schedules").font(.title2.weight(.semibold))
          Text("Recurring work for the selected daemon.").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button { perform { try await actions.reload() } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh schedules")
        Button(tab == "Templates" ? "New template" : "New schedule", systemImage: "plus") {
          if tab == "Templates" { templateToEdit = nil; editingTemplate = true }
          else { jobToEdit = nil; newTemplateID = nil; editorArea = "Schedule"; editingJob = true }
        }.buttonStyle(.borderedProminent).disabled(tab == "Schedules" && templates.isEmpty)
      }.padding(24)
      Divider()
      DesktopSectionPicker(title: "", items: ["Schedules", "Templates"], selection: $tab, label: { $0 })
      Divider()
      if let error { message(error, color: .red) }
      if let notice { message(notice, color: DesktopTheme.accent) }
      if tab == "Templates" { templateLibrary }
      else {
        GeometryReader { size in
          HSplitView {
            scheduleList.frame(minWidth: 360)
            ScrollView {
              if let selected { inspector(selected).padding(24) }
              else { ContentUnavailableView("Select a schedule", systemImage: "clock", description: Text("Inspect its prompt, launch choices and next run.")) }
            }.frame(minWidth: 300, idealWidth: size.size.width * 0.4, maxWidth: .infinity)
              .background(DesktopTheme.canvas)
          }
        }
      }
    }.disabled(busy)
  }
  private func message(_ text: String, color: Color) -> some View {
    HStack { Text(text).font(.callout).foregroundStyle(color).textSelection(.enabled); Spacer(); Button("Dismiss") { error = nil; notice = nil }.controlSize(.small) }.padding(12)
  }
  private var scheduleList: some View {
    VStack(spacing: 16) {
      TextField("Search schedules or repositories", text: $query).textFieldStyle(.roundedBorder)
      ViewThatFits(in: .horizontal) {
        HStack { filters }
        VStack { filters }
      }.controlSize(.small)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if jobs.isEmpty {
            ContentUnavailableView { Label("Start with a reusable prompt", systemImage: "clock.badge.checkmark") }
              description: { Text("Create a template, then choose a repository, configuration and schedule.") }
              actions: { Button("New template") { templateToEdit = nil; editingTemplate = true } }
          } else if filtered.isEmpty {
            ContentUnavailableView.search(text: query)
            Button("Clear filters") { query = ""; repository = ""; profile = ""; state = "All states" }
          } else {
            if filtered.contains(where: \.catchupPending) {
              Label("Needs attention", systemImage: "exclamationmark.circle").font(.caption.weight(.semibold)).foregroundStyle(.orange)
              ForEach(filtered.filter(\.catchupPending)) { scheduleRow($0) }
            }
            Text("Other schedules").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(filtered.filter { !$0.catchupPending }) { scheduleRow($0) }
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }.padding(20)
  }
  @ViewBuilder private var filters: some View {
    Picker("Repository", selection: $repository) {
      Text("All repositories").tag("")
      ForEach(Array(Set(jobs.map(repoID).filter { !$0.isEmpty })).sorted(), id: \.self) { id in
        Text(configuration?.list(.repository).first { $0.id == id }?.name ?? id).tag(id)
      }
    }.labelsHidden().accessibilityLabel("Filter by repository")
    Picker("Configuration", selection: $profile) {
      Text("All configurations").tag("")
      ForEach(Array(Set(jobs.map(profileName))).sorted(), id: \.self) { Text($0).tag($0) }
    }.labelsHidden().accessibilityLabel("Filter by configuration")
    Picker("State", selection: $state) { ForEach(["All states", "Needs attention", "Active", "Disabled"], id: \.self) { Text($0).tag($0) } }.labelsHidden()
  }
  private func scheduleRow(_ job: ScheduledJob) -> some View {
    Button { selectedID = job.id } label: {
      HStack(spacing: 15) {
        VStack(alignment: .leading, spacing: 7) {
          HStack { Text(job.name).fontWeight(.semibold); if !job.enabled { Text("Disabled").foregroundStyle(.secondary) } }
          Text(repoName(job)).foregroundStyle(DesktopTheme.accent)
          Text(profileName(job) + " · " + job.cronExpression).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        VStack(alignment: .trailing, spacing: 7) {
          Text(job.catchupPending ? "Decision needed" : job.enabled ? date(job.nextRunAt) : "Disabled")
            .foregroundStyle(job.catchupPending ? .orange : .secondary)
          if job.scan != nil { Text(job.lastReportId.map { "Report · " + $0 } ?? "No report yet").foregroundStyle(.secondary).lineLimit(1) }
          else if let id = job.lastPodId { Text("Pod · " + id).foregroundStyle(.secondary) }
          else { Text("No output yet").foregroundStyle(.secondary) }
        }
      }.font(.caption).padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(job.id == selectedID ? DesktopTheme.selection : DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(job.id == selectedID ? DesktopTheme.accent : DesktopTheme.line))
        .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel("Select \(job.name)")
  }
  private func inspector(_ job: ScheduledJob) -> some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack {
        Text(job.catchupPending ? "Catch-up pending" : job.enabled ? "Active" : "Disabled").font(.caption).foregroundStyle(job.catchupPending ? .orange : DesktopTheme.accent)
        Spacer()
        Button("Edit") { jobToEdit = job; newTemplateID = nil; editorArea = "Schedule"; editingJob = true }
        Menu("Actions") {
          Button("Run now") { catchupRun = false; jobToRun = job }
          Button("Reports & scan policy") { openReports(job) }
          Button(job.enabled ? "Disable schedule" : "Enable schedule") { perform { try await actions.update(job.id, UpdateScheduledJobRequest(enabled: !job.enabled)) } }
          Divider()
          Button("Delete schedule…", role: .destructive) { jobToDelete = job }
        }.fixedSize()
      }.controlSize(.small)
      Text(job.name).font(.title2.weight(.semibold))
      Button(repoName(job), systemImage: "folder") { repository = repoID(job) }.buttonStyle(.plain).foregroundStyle(DesktopTheme.accent)
      if job.catchupPending {
        DesktopPanel(title: "A run was missed") {
          Text("Run it once now or skip this missed run.").font(.callout).foregroundStyle(.secondary)
          HStack {
            Button("Run missed job") { catchupRun = true; jobToRun = job }.buttonStyle(.borderedProminent)
            Button("Skip missed run") { perform { try await actions.skip(job) } }
          }.controlSize(.small)
        }
      }
      Grid(alignment: .leading, horizontalSpacing: 30, verticalSpacing: 20) {
        GridRow { fact("Schedule", job.cronExpression); fact("Next run", job.enabled ? date(job.nextRunAt) : "Disabled") }
        GridRow { fact("Last run", job.lastRunAt.map(date) ?? "Never run"); output(job) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if job.scan != nil {
        DesktopPanel(title: "Report-only scan") {
          Text("Collects evidence and findings. Repair requires a separate human selection and launch.").font(.callout).foregroundStyle(.secondary)
          Button("Open scan reports") { openReports(job) }
        }
      }
      DesktopPanel(title: "Task prompt") {
        Text(job.task).font(.callout).textSelection(.enabled)
        Text("Template: \(job.templateName)").font(.caption).foregroundStyle(.secondary)
      }
      DesktopPanel(title: "Launch choices") {
        fact("Profile", profileName(job))
        Text("Choices resolve again for each future run. A run already admitted keeps its configuration.").font(.caption).foregroundStyle(.secondary)
        Button("Inspect launch choices") { jobToEdit = job; editorArea = "Launch setup"; editingJob = true }
      }
      Text("Cron uses the daemon’s time zone. Dates are displayed in your Mac’s time zone, shown above.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func fact(_ title: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); Text(value).font(.callout).textSelection(.enabled) }
  }
  @ViewBuilder private func output(_ job: ScheduledJob) -> some View {
    if job.scan != nil { Button("Latest scan report") { openReports(job) } }
    else if let id = job.lastPodId { Button("Pod · \(id)") { openPod(id) } }
    else { fact("Latest output", "No output yet") }
  }
  private var templateLibrary: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        TextField("Search templates or prompt text", text: $query).textFieldStyle(.roundedBorder)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), alignment: .top)], alignment: .leading, spacing: 18) {
          ForEach(templates.filter { query.isEmpty || ($0.name + $0.prompt).localizedCaseInsensitiveContains(query) }) { template in
            DesktopPanel(title: template.name) {
              Text(template.prompt).font(.callout).foregroundStyle(.secondary).lineLimit(5)
              let count = jobs.filter { $0.templateId == template.id }.count
              Text("\(template.fields.count) fields · \(count) linked schedules").font(.caption).foregroundStyle(.secondary)
              HStack {
                Menu { Button("Delete template…", role: .destructive) { templateToDelete = template }.disabled(count > 0) } label: { Image(systemName: "ellipsis") }.help(count > 0 ? "Linked templates cannot be deleted" : "Template actions")
                Spacer()
                Button("Edit") { templateToEdit = template; editingTemplate = true }
                Button("Use template") { jobToEdit = nil; newTemplateID = template.id; editorArea = "Schedule"; editingJob = true }.buttonStyle(.borderedProminent)
              }.controlSize(.small)
            }
          }
        }
        if templates.isEmpty { ContentUnavailableView("Create your first template", systemImage: "doc.text", description: Text("Define a prompt and fields that schedules can override.")) }
      }.padding(24)
    }
  }
  private func date(_ iso: String) -> String { DesktopScheduleTime.label(iso) }
  private func setDirty(_ value: Bool) { dirty = value; onDirty(value) }
  private func setBusy(_ value: Bool) { busy = value; onBusy(value) }
  private func navigate(_ action: @escaping () -> Void) {
    guard !busy else { return }
    if dirty { pendingNavigation = action; discard = true } else { action() }
  }
  private func perform(_ action: @escaping () async throws -> Void) {
    guard !busy else { return }
    setBusy(true); error = nil
    Task { @MainActor in defer { setBusy(false) }; do { try await action() } catch { self.error = error.localizedDescription } }
  }
}
