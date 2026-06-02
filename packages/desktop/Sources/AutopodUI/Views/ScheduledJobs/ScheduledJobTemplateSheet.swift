import AutopodClient
import SwiftUI

/// Modal sheet for creating or editing a reusable scheduled job template.
public struct ScheduledJobTemplateSheet: View {
  @Binding public var isPresented: Bool
  public var template: ScheduledJobTemplate?
  public var onSave: ((CreateScheduledJobTemplateRequest) -> Void)?

  @State private var name: String
  @State private var prompt: String

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
  }

  private var canSave: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
          prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines)
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
}

#Preview("Scheduled Job Template") {
  @Previewable @State var show = true
  ScheduledJobTemplateSheet(isPresented: $show)
}
