import AutopodClient
import Foundation
import SwiftUI

/// Modal sheet for creating or editing a reusable scheduled job template.
public struct ScheduledJobTemplateSheet: View {
  @Binding public var isPresented: Bool
  public var template: ScheduledJobTemplate?
  public var onSave: ((CreateScheduledJobTemplateRequest) -> Void)?

  @State private var name: String
  @State private var prompt: String
  @State private var fields: [TemplateFieldDraft]

  public init(
    isPresented: Binding<Bool>,
    template: ScheduledJobTemplate? = nil,
    onSave: ((CreateScheduledJobTemplateRequest) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.template = template
    self.onSave = onSave
    self._name = State(initialValue: template?.name ?? "")
    self._prompt = State(initialValue: template?.prompt ?? "")
    self._fields = State(initialValue: (template?.fields ?? []).map(TemplateFieldDraft.init))
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
        .padding(20)
      }

      Divider()
      actions
    }
    .frame(minWidth: 500, maxWidth: 500, minHeight: 420)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var header: some View {
    HStack {
      Text(template == nil ? "New Template" : "Edit Template")
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
      Button(template == nil ? "Create Template" : "Save Changes") {
        onSave?(CreateScheduledJobTemplateRequest(
          name: name.trimmingCharacters(in: .whitespacesAndNewlines),
          prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
          fields: fields.map(\.templateField)
        ))
        isPresented = false
      }
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave)
    }
    .padding(16)
  }

  private func formSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.system(.caption).weight(.semibold))
        .foregroundStyle(.secondary)
      content()
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
