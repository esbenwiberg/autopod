import AutopodClient
import Foundation
import SwiftUI

/// Modal sheet for creating or editing a reusable scheduled job template.
public struct ScheduledJobTemplateSheet: View {
  @Binding public var isPresented: Bool
  public var template: ScheduledJobTemplate?
  public var onSave: ((CreateScheduledJobTemplateRequest) -> Void)?

  public var linkedScheduleNames: [String] = []
  public var embedded = false
  public var saveAwaited: ((CreateScheduledJobTemplateRequest) async throws -> Void)?
  public var onDirtyChanged: (Bool) -> Void = { _ in }
  public var onBusyChanged: (Bool) -> Void = { _ in }
  @State private var saving = false
  @State private var saveError: String?
  @State private var baseline: TemplateDraftSnapshot?
  private var draftKey: TemplateDraftSnapshot { TemplateDraftSnapshot(name: name, prompt: prompt, fields: fields) }

  @State private var name: String
  @State private var prompt: String
  @State private var fields: [TemplateFieldDraft]

  public init(
    isPresented: Binding<Bool>,
    template: ScheduledJobTemplate? = nil,
    onSave: ((CreateScheduledJobTemplateRequest) -> Void)? = nil,
    embedded: Bool = false,
    saveAwaited: ((CreateScheduledJobTemplateRequest) async throws -> Void)? = nil,
    onDirtyChanged: @escaping (Bool) -> Void = { _ in },
    onBusyChanged: @escaping (Bool) -> Void = { _ in },
    linkedScheduleNames: [String] = []
  ) {
    self._isPresented = isPresented
    self.template = template
    self.onSave = onSave
    self.embedded = embedded; self.saveAwaited = saveAwaited
    self.onDirtyChanged = onDirtyChanged; self.onBusyChanged = onBusyChanged
    self.linkedScheduleNames = linkedScheduleNames
    self._name = State(initialValue: template?.name ?? "")
    self._prompt = State(initialValue: template?.prompt ?? "")
    let initialFields = (template?.fields ?? []).map(TemplateFieldDraft.init)
    self._fields = State(initialValue: initialFields)
    self._baseline = State(initialValue: TemplateDraftSnapshot(name: template?.name ?? "", prompt: template?.prompt ?? "", fields: initialFields))
  }

  private var canSave: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && fields.allSatisfy(\.isValid)
      && Set(fields.map { $0.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        .count == fields.count
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let saveError { Text(saveError).foregroundStyle(.red).textSelection(.enabled) }
          if embedded {
            Text("Schedules fill in the fields when they run. Changes to this reusable prompt affect linked schedules.")
              .font(.callout).foregroundStyle(.secondary)
            if !linkedScheduleNames.isEmpty {
              Text("Used by: " + linkedScheduleNames.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
            }
          }
          formSection("Name") {
            HStack(spacing: 6) {
              Image(systemName: "doc.text")
                .foregroundStyle(.tertiary)
                .font(.system(size: 11))
              TextField("e.g. log triage", text: $name)
                .textFieldStyle(.plain)
                .font(.system(.callout, design: .monospaced))
            }
            .padding(8)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
          }

          formSection("Prompt") {
            TextEditor(text: $prompt)
              .font(.system(.body, design: .default))
              .frame(minHeight: 150, maxHeight: 240)
              .padding(6)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              .overlay(
                RoundedRectangle(cornerRadius: 6)
                  .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
              )
          }

          formSection("Fields") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach($fields) { $field in
                templateFieldRow(field: $field)
              }

              Button {
                fields.append(TemplateFieldDraft())
              } label: {
                Label("Add Field", systemImage: "plus")
              }
              .buttonStyle(.borderless)
              .controlSize(.small)
            }
          }
        }
        .padding(24)
        .frame(maxWidth: embedded ? 1100 : .infinity, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      Divider()
      actions
    }
    .frame(minWidth: embedded ? 600 : 500, maxWidth: embedded ? .infinity : 500, minHeight: 420)
    .background(embedded ? DesktopTheme.surface : Color(nsColor: .windowBackgroundColor))
    .disabled(saving)
    .onChange(of: draftKey) { _, value in onDirtyChanged(value != baseline) }
  }

  private var header: some View {
    HStack {
      if embedded {
        VStack(alignment: .leading, spacing: 8) {
          Button("‹ Templates") { isPresented = false }.buttonStyle(.plain).foregroundStyle(.secondary)
          Text(template?.name ?? "New template").font(.title2.weight(.semibold))
          Text("Reusable prompt & field definitions").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
      } else {
        Text(template == nil ? "New Template" : "Edit Template").font(.headline)
        Spacer()
        Button { isPresented = false } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary).font(.title3)
        }.buttonStyle(.borderless)
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 20)
    .padding(.bottom, 12)
  }

  private var actions: some View {
    HStack {
      if embedded { Text(draftKey == baseline ? "No changes" : "Unsaved changes").font(.caption).foregroundStyle(.secondary) }
      Spacer()
      Button("Cancel") { isPresented = false }
        .keyboardShortcut(.cancelAction)
      Button(saving ? "Saving…" : template == nil ? "Create Template" : "Save Changes") {
        let request = CreateScheduledJobTemplateRequest(
          name: name.trimmingCharacters(in: .whitespacesAndNewlines),
          prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
          fields: fields.map(\.templateField))
        if let saveAwaited {
          saving = true; onBusyChanged(true); saveError = nil
          Task { @MainActor in
            defer { saving = false; onBusyChanged(false) }
            do {
              try await saveAwaited(request)
              onDirtyChanged(false); onBusyChanged(false); saving = false
              isPresented = false
            } catch { saveError = error.localizedDescription }
          }
        } else { onSave?(request); isPresented = false }
      }
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave || saving)
    }
    .padding(16)
  }

  private func formSection<Content: View>(_ title: String, @ViewBuilder content: @escaping () -> Content) -> some View {
    Group {
      if embedded { DesktopPanel(title: title, content: content) }
      else {
        VStack(alignment: .leading, spacing: 5) {
          Text(title).font(.system(.caption).weight(.semibold)).foregroundStyle(.secondary)
          content()
        }
      }
    }
  }

  private func templateFieldRow(field: Binding<TemplateFieldDraft>) -> some View {
    HStack(spacing: 8) {
      TextField("key", text: field.key)
        .textFieldStyle(.plain)
        .font(.system(.caption, design: .monospaced))
        .frame(width: 110)
        .padding(6)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))

      TextField("Label", text: field.label)
        .textFieldStyle(.plain)
        .font(.caption)
        .padding(6)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))

      TextField("Default", text: field.defaultValue)
        .textFieldStyle(.plain)
        .font(.caption)
        .frame(width: 110)
        .padding(6)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))

      Toggle("Required", isOn: field.required)
        .toggleStyle(.checkbox)
        .font(.caption)

      Button {
        fields.removeAll { $0.id == field.wrappedValue.id }
      } label: {
        Image(systemName: "trash")
      }
      .buttonStyle(.borderless)
      .foregroundStyle(.secondary)
    }
  }
}

private struct TemplateFieldDraft: Identifiable, Hashable {
  let id: UUID
  var key: String
  var label: String
  var required: Bool
  var defaultValue: String

  init(
    id: UUID = UUID(),
    key: String = "",
    label: String = "",
    required: Bool = false,
    defaultValue: String = ""
  ) {
    self.id = id
    self.key = key
    self.label = label
    self.required = required
    self.defaultValue = defaultValue
  }

  init(_ field: ScheduledJobTemplateField) {
    self.init(
      key: field.key,
      label: field.label,
      required: field.required,
      defaultValue: field.defaultValue ?? ""
    )
  }

  var isValid: Bool {
    let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
    return !trimmedKey.isEmpty
      && !trimmedLabel.isEmpty
      && trimmedKey.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil
  }

  var templateField: ScheduledJobTemplateField {
    let trimmedDefault = defaultValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return ScheduledJobTemplateField(
      key: key.trimmingCharacters(in: .whitespacesAndNewlines),
      label: label.trimmingCharacters(in: .whitespacesAndNewlines),
      required: required,
      defaultValue: trimmedDefault.isEmpty ? nil : trimmedDefault
    )
  }
}

#Preview("Scheduled Job Template") {
  @Previewable @State var show = true
  ScheduledJobTemplateSheet(isPresented: $show)
}

private struct TemplateDraftSnapshot: Equatable {
  var name: String
  var prompt: String
  var fields: [TemplateFieldDraft]
}
