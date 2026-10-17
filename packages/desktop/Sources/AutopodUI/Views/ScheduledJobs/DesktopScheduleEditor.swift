import AutopodClient
import SwiftUI

struct DesktopScheduleEditor: View {
  let job: ScheduledJob?
  let templates: [ScheduledJobTemplate]
  let profiles: [String]
  let configuration: LaunchConfigurationActions?
  let actions: ScheduledWorkspaceActions
  let onClose: () -> Void
  let onDirty: (Bool) -> Void
  let onBusy: (Bool) -> Void
  @State private var draft: ScheduledJobDraft
  private let original: ScheduledJobDraft
  private var useComposable: Bool { configuration != nil && (job == nil || job?.launch != nil) }
  @State private var area = "Schedule"
  @State private var busy = false
  @State private var error: String?

  init(job: ScheduledJob?, templates: [ScheduledJobTemplate], profiles: [String],
       configuration: LaunchConfigurationActions?, actions: ScheduledWorkspaceActions,
       templateID: String? = nil, initialArea: String = "Schedule", onClose: @escaping () -> Void,
       onDirty: @escaping (Bool) -> Void, onBusy: @escaping (Bool) -> Void) {
    self.job = job; self.templates = templates; self.profiles = profiles
    self.configuration = configuration; self.actions = actions
    self.onClose = onClose; self.onDirty = onDirty; self.onBusy = onBusy
    let initial = ScheduledJobDraft(job: job, templates: templates, profiles: profiles, templateID: templateID)
    _draft = State(initialValue: initial); original = initial; _area = State(initialValue: initialArea)
  }
  private var template: ScheduledJobTemplate? { templates.first { $0.id == draft.templateID } }
  private let areas = ["Schedule", "Launch setup", "Prompt & fields", "Advanced"]
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 8) {
          Button("‹ Schedules", action: onClose).buttonStyle(.plain).foregroundStyle(.secondary)
          Text(job?.name ?? "New schedule").font(.title2.weight(.semibold))
          Text("Changes apply to future runs.").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
      }.padding(24)
      Divider()
      GeometryReader { size in
        HStack(spacing: 0) {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(areas, id: \.self) { item in
              Button { area = item } label: {
                Text(item).font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                  .foregroundStyle(area == item ? DesktopTheme.accent : .secondary)
                  .background(area == item ? DesktopTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 6))
              }.buttonStyle(.plain)
            }
            Spacer()
          }.padding(12).frame(width: 165).background(DesktopTheme.canvas)
          Divider()
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              Text(area).font(.title3.weight(.semibold))
              if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
              editorArea
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
          }
          if size.size.width > 1180 {
            Divider()
            VStack(alignment: .leading, spacing: 20) {
              Text("SCHEDULE SUMMARY").font(.caption2).foregroundStyle(.secondary)
              Text(template?.name ?? "Choose a template").font(.headline)
              Text(draft.cron).font(.system(.caption, design: .monospaced))
              Text("Repository, profile and preset references resolve again when each run is admitted.")
              Text("Running pods keep the configuration they captured.")
              Spacer()
            }.font(.caption).foregroundStyle(.secondary).padding(24).frame(width: 265)
              .background(DesktopTheme.canvas)
          }
        }
      }
      Divider()
      HStack {
        Text(draft == original ? "No changes" : "Unsaved changes").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Cancel", action: onClose)
        Button(busy ? "Saving…" : job == nil ? "Create schedule" : "Save schedule") { save() }
          .buttonStyle(.borderedProminent)
          .disabled(busy || !draft.canSave(template: template, composable: useComposable))
      }.padding(18).background(DesktopTheme.canvas)
    }
    .background(DesktopTheme.surface).disabled(busy)
    .onChange(of: draft) { _, value in onDirty(value != original) }
  }

  @ViewBuilder private var editorArea: some View {
    switch area {
    case "Schedule":
      DesktopPanel(title: "Timing") {
        Picker("Template", selection: $draft.templateID) {
          Text("Choose template").tag("")
          ForEach(templates.sorted { $0.name < $1.name }) { Text($0.name).tag($0.id) }
        }
        LabeledContent("Cron expression") {
          TextField("0 9 * * 1-5", text: $draft.cron).font(.system(.callout, design: .monospaced))
            .frame(maxWidth: 360).accessibilityLabel("Cron expression")
        }
        Text("Five fields: minute, hour, day, month, weekday. The daemon validates the expression.")
          .font(.caption).foregroundStyle(.secondary)
        HStack {
          Button("Daily 09:00") { draft.cron = "0 9 * * *" }
          Button("Monday 02:00") { draft.cron = "0 2 * * 1" }
          Button("Every 30 min") { draft.cron = "*/30 * * * *" }
        }.controlSize(.small)
        Text("Cron is evaluated in the daemon’s time zone. Run times in the list include their display time zone.")
          .font(.caption).foregroundStyle(.secondary)
        Toggle("Enabled", isOn: $draft.enabled).toggleStyle(.switch)
      }
    case "Launch setup":
      DesktopPanel(title: "Repository & configuration") {
        if useComposable, let configuration {
          ScheduledLaunchSelectionEditor(actions: configuration, selection: $draft.launch, task: template?.prompt ?? "", includeAdvanced: false)
        } else {
          Picker("Profile", selection: $draft.profile) {
            ForEach(Array(Set(profiles + [draft.profile])).sorted(), id: \.self) { Text($0).tag($0) }
          }
        }
      }
    case "Prompt & fields":
      DesktopPanel(title: "Template prompt") {
        Text(template?.prompt ?? "Choose a template first.").font(.callout).textSelection(.enabled)
        Text("Edit reusable prompts in Templates. Values below apply to this schedule.").font(.caption).foregroundStyle(.secondary)
      }
      DesktopPanel(title: "Field overrides") {
        if template?.fields.isEmpty != false { Text("This template has no override fields.").foregroundStyle(.secondary) }
        ForEach(template?.fields ?? [], id: \.key) { field in
          LabeledContent(field.label + (field.required ? " · required" : "")) {
            TextField(field.key, text: Binding(
              get: { draft.fields[field.key] ?? field.defaultValue ?? "" },
              set: { draft.fields[field.key] = $0 }))
              .frame(maxWidth: 400).accessibilityLabel(field.label)
          }
        }
      }
    default:
      DesktopPanel(title: "Advanced configuration") {
        if useComposable, let configuration {
          ScheduledLaunchSelectionEditor(actions: configuration, selection: $draft.launch,
            task: template?.prompt ?? "", advancedOnly: true)
        } else {
          Text("This legacy schedule uses its saved profile. Profile settings remain available in Profiles.")
            .font(.callout).foregroundStyle(.secondary)
        }
      }
    }
  }
  private func save() {
    guard !busy, draft.canSave(template: template, composable: useComposable) else { return }
    busy = true; onBusy(true); error = nil
    Task { @MainActor in
      defer { busy = false; onBusy(false) }
      do {
        let fields = draft.fieldValues(template)
        if let job {
          try await actions.update(job.id, UpdateScheduledJobRequest(
            templateId: draft.templateID, fieldValues: fields,
            profileName: useComposable ? nil : draft.profile,
            launch: useComposable ? draft.launch : nil,
            cronExpression: draft.cron.trimmingCharacters(in: .whitespacesAndNewlines), enabled: draft.enabled))
        } else {
          try await actions.create(CreateScheduledJobRequest(
            templateId: draft.templateID, profileName: useComposable ? nil : draft.profile,
            launch: useComposable ? draft.launch : nil, fieldValues: fields,
            cronExpression: draft.cron.trimmingCharacters(in: .whitespacesAndNewlines), enabled: draft.enabled))
        }
        onDirty(false); onBusy(false); busy = false; onClose()
      } catch { self.error = error.localizedDescription }
    }
  }
}
