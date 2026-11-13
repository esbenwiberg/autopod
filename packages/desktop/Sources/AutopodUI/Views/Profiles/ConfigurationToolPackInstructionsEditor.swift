import AutopodClient
import SwiftUI

struct ConfigurationToolPackInstructionsEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  private var instructions: Binding<[ConfigurationJSON]> {
    Binding(get: { payload["instructions"]?.array ?? [] }, set: { payload["instructions"] = .array($0) })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ConfigurationHelpSummary(topic: .topic("toolPack.instructions"))
      if instructions.wrappedValue.isEmpty {
        Text("No extra guidance. Add a section only when this pack needs reusable working rules.")
          .font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("tool-pack-instructions-empty")
      }
      ConfigurationObjectListEditor(
        title: "Instruction sections", values: instructions,
        initial: { ["heading": .string(""), "content": .string("")] }
      ) { fields in
        VStack(alignment: .leading, spacing: 6) {
          ConfigurationHelpLabel(title: "Heading", topic: .topic("toolPack.instructions.heading"))
            .font(.caption).foregroundStyle(.secondary)
          TextField("Heading", text: text(fields, "heading"))
            .accessibilityIdentifier("tool-pack-instruction-heading")
          ConfigurationHelpLabel(title: "Instructions", topic: .topic("toolPack.instructions.content"))
            .font(.caption).foregroundStyle(.secondary)
          TextEditor(text: text(fields, "content"))
            .font(.system(.body, design: .monospaced))
            .frame(minHeight: 120, idealHeight: 160, maxHeight: 260)
            .accessibilityLabel("Instruction text")
            .accessibilityIdentifier("tool-pack-instruction-content")
        }
      }
    }
  }
  private func text(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String) -> Binding<String> {
    Binding(get: { fields.wrappedValue[key]?.string ?? "" }, set: { fields.wrappedValue[key] = .string($0) })
  }
}
