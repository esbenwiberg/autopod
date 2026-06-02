import AutopodClient
import SwiftUI

/// Modal sheet for editing an existing scheduled job.
public struct EditScheduledJobSheet: View {
  @Binding public var isPresented: Bool
  public let job: ScheduledJob
  public var templates: [ScheduledJobTemplate]
  public var profileNames: [String]
  public var onEditJob: ((String, UpdateScheduledJobRequest) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    job: ScheduledJob,
    templates: [ScheduledJobTemplate] = [],
    profileNames: [String] = [],
    onEditJob: ((String, UpdateScheduledJobRequest) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.job = job
    self.templates = templates
    self.profileNames = profileNames
    self.onEditJob = onEditJob
    self._selectedTemplateId = State(initialValue: job.templateId)
    self._selectedProfile = State(initialValue: job.profileName)
    self._cronExpression = State(initialValue: job.cronExpression)
    self._enabled = State(initialValue: job.enabled)
  }

  private var sortedTemplates: [ScheduledJobTemplate] { templates.sorted { $0.name < $1.name } }
  private var profiles: [String] {
    let all = Set(profileNames + [job.profileName])
    return all.sorted()
  }

  @State private var selectedTemplateId: String
  @State private var selectedProfile: String
  @State private var cronExpression: String
  @State private var enabled: Bool

  private var canSave: Bool {
    !selectedTemplateId.isEmpty
      && !selectedProfile.isEmpty
      && isValidCron(cronExpression)
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          formSection("Template") {
            Picker("", selection: $selectedTemplateId) {
              ForEach(sortedTemplates) { template in
                Text(template.name).tag(template.id)
              }
            }
            .labelsHidden()
          }

          formSection("Profile") {
            Picker("", selection: $selectedProfile) {
              ForEach(profiles, id: \.self) { profile in
                Text(profile).tag(profile)
              }
            }
            .labelsHidden()
          }

          formSection("Schedule (cron)") {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                Image(systemName: "calendar.badge.clock")
                  .foregroundStyle(.tertiary)
                  .font(.system(size: 11))
                TextField("0 9 * * 1-5", text: $cronExpression)
                  .textFieldStyle(.plain)
                  .font(.system(.callout, design: .monospaced))
              }
              .padding(8)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              .overlay(
                RoundedRectangle(cornerRadius: 6)
                  .stroke(cronValidationColor, lineWidth: 1)
              )

              HStack(spacing: 12) {
                cronHint("0 9 * * *", label: "daily 9am")
                cronHint("0 2 * * 1", label: "Mon 2am")
                cronHint("*/30 * * * *", label: "every 30m")
              }
            }
          }

          formSection("State") {
            Toggle("Enabled", isOn: $enabled)
              .toggleStyle(.switch)
              .controlSize(.small)
          }
        }
        .padding(20)
      }

      Divider()
      actions
    }
    .frame(minWidth: 460, maxWidth: 460, minHeight: 360)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var header: some View {
    HStack {
      Text("Edit Scheduled Job")
        .font(.headline)
      Spacer()
      Button {
        isPresented = false
      } label: {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.tertiary)
          .font(.title3)
      }
      .buttonStyle(.borderless)
    }
    .padding(.horizontal, 20)
    .padding(.top, 20)
    .padding(.bottom, 12)
  }

  private var actions: some View {
    HStack {
      Spacer()
      Button("Cancel") { isPresented = false }
        .keyboardShortcut(.cancelAction)
      Button("Save Changes") {
        let req = UpdateScheduledJobRequest(
          templateId: selectedTemplateId,
          profileName: selectedProfile,
          cronExpression: cronExpression.trimmingCharacters(in: .whitespacesAndNewlines),
          enabled: enabled
        )
        onEditJob?(job.id, req)
        isPresented = false
      }
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave)
    }
    .padding(16)
  }

  private func isValidCron(_ expr: String) -> Bool {
    let parts = expr.trimmingCharacters(in: .whitespacesAndNewlines)
      .split(separator: " ", omittingEmptySubsequences: true)
    return parts.count == 5
  }

  private var cronValidationColor: Color {
    let trimmed = cronExpression.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return Color(nsColor: .separatorColor).opacity(0) }
    return isValidCron(trimmed) ? .green.opacity(0.5) : .red.opacity(0.5)
  }

  private func cronHint(_ expr: String, label: String) -> some View {
    Button {
      cronExpression = expr
    } label: {
      VStack(alignment: .leading, spacing: 1) {
        Text(expr)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.blue)
        Text(label)
          .font(.system(size: 9))
          .foregroundStyle(.tertiary)
      }
    }
    .buttonStyle(.borderless)
  }

  private func formSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.system(.caption).weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
  }
}

#Preview("Edit Scheduled Job") {
  @Previewable @State var show = true
  EditScheduledJobSheet(
    isPresented: $show,
    job: .previewActive,
    templates: [.previewLogTriage, .previewGarbageCleanup],
    profileNames: ["my-app", "webapp"]
  )
}
