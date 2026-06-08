import AutopodClient
import SwiftUI

/// Modal sheet for creating a scheduled job from a reusable template.
public struct CreateScheduledJobSheet: View {
  @Binding public var isPresented: Bool
  public var templates: [ScheduledJobTemplate]
  public var profileNames: [String]
  public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    templates: [ScheduledJobTemplate] = [],
    profileNames: [String] = ["my-app"],
    onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.templates = templates
    self.profileNames = profileNames
    self.onCreateJob = onCreateJob
  }

  private var profiles: [String] { profileNames.isEmpty ? ["my-app"] : profileNames.sorted() }
  private var sortedTemplates: [ScheduledJobTemplate] { templates.sorted { $0.name < $1.name } }
  private var selectedTemplate: ScheduledJobTemplate? {
    sortedTemplates.first { $0.id == selectedTemplateId }
  }
  private var selectedFields: [ScheduledJobTemplateField] {
    selectedTemplate?.fields ?? []
  }

  @State private var selectedTemplateId = ""
  @State private var selectedProfile = ""
  @State private var cronExpression = ""
  @State private var enabled = true
  @State private var fieldValues: [String: String] = [:]

  private var canCreate: Bool {
    !selectedTemplateId.isEmpty
      && !selectedProfile.isEmpty
      && isValidCron(cronExpression)
      && hasRequiredFieldValues
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

          if !selectedFields.isEmpty {
            formSection("Overrides") {
              VStack(alignment: .leading, spacing: 8) {
                ForEach(selectedFields, id: \.key) { field in
                  overrideField(field)
                }
              }
            }
          }

          formSection("State") {
            Toggle("Enable immediately", isOn: $enabled)
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
    .onAppear {
      if selectedTemplateId.isEmpty {
        selectedTemplateId = sortedTemplates.first?.id ?? ""
      }
      if selectedProfile.isEmpty {
        selectedProfile = profiles.first ?? ""
      }
      reconcileFieldValues()
    }
    .onChange(of: selectedTemplateId) { _, _ in
      reconcileFieldValues()
    }
  }

  private var header: some View {
    HStack {
      Text("New Scheduled Job")
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
      Button("Create Job") {
        let req = CreateScheduledJobRequest(
          templateId: selectedTemplateId,
          profileName: selectedProfile,
          fieldValues: selectedFields.isEmpty ? nil : fieldValuesForSubmit(),
          cronExpression: cronExpression.trimmingCharacters(in: .whitespacesAndNewlines),
          enabled: enabled
        )
        onCreateJob?(req)
        isPresented = false
      }
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
      .disabled(!canCreate)
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

  private var hasRequiredFieldValues: Bool {
    selectedFields.allSatisfy { field in
      let value = fieldValues[field.key] ?? field.defaultValue ?? ""
      return !field.required || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private func fieldValuesForSubmit() -> [String: String] {
    Dictionary(uniqueKeysWithValues: selectedFields.map { field in
      (field.key, fieldValues[field.key] ?? field.defaultValue ?? "")
    })
  }

  private func reconcileFieldValues() {
    var next: [String: String] = [:]
    for field in selectedFields {
      next[field.key] = fieldValues[field.key] ?? field.defaultValue ?? ""
    }
    fieldValues = next
  }

  private func overrideField(_ field: ScheduledJobTemplateField) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 4) {
        Text(field.label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        if field.required {
          Text("required")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.orange)
        }
      }
      TextField(field.key, text: Binding(
        get: { fieldValues[field.key] ?? field.defaultValue ?? "" },
        set: { fieldValues[field.key] = $0 }
      ))
      .textFieldStyle(.plain)
      .font(.system(.callout, design: .monospaced))
      .padding(8)
      .background(Color(nsColor: .controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 6))
    }
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

#Preview("Create Scheduled Job") {
  @Previewable @State var show = true
  CreateScheduledJobSheet(
    isPresented: $show,
    templates: [.previewLogTriage, .previewGarbageCleanup],
    profileNames: ["my-app", "webapp", "backend"]
  )
}
