import AutopodClient
import SwiftUI

/// Schema values are {value: string} or {secretId: string}; secret contents never belong here.
struct ConfigurationValueMapEditor: View {
  let title: String
  let context: String
  let id: String
  @Binding var values: [String: ConfigurationJSON]
  @State private var newName = ""
  private var candidate: String { newName.trimmingCharacters(in: .whitespacesAndNewlines) }
  var body: some View {
    ConfigurationSection(title: title, subtitle: context) {
      if values.isEmpty { Text("No entries yet.").font(.callout).foregroundStyle(.secondary) }
      ForEach(values.keys.sorted(), id: \.self) { key in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(key).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            Spacer()
            Button("Remove \(key)", systemImage: "minus.circle", role: .destructive) { values.removeValue(forKey: key) }
              .labelStyle(.iconOnly).accessibilityIdentifier("\(id)-remove-\(key)")
          }
          if values[key]?["value"]?.string != nil || values[key]?["secretId"]?.string != nil {
            Toggle("Use enrolled credential", isOn: Binding(get: { values[key]?["secretId"]?.string != nil }, set: {
              // A deliberate source change replaces the mutually exclusive schema branch.
              values[key] = .object([$0 ? "secretId" : "value": .string("")])
            })).accessibilityIdentifier("\(id)-source-\(key)")
            let source = values[key]?["secretId"]?.string != nil ? "secretId" : "value"
            TextField(source == "secretId" ? "Credential ID for \(key)" : "Value for \(key)", text: Binding(get: {
              values[key]?[source]?.string ?? ""
            }, set: {
              var entry = values[key]?.object ?? [:]; entry[source] = .string($0); values[key] = .object(entry)
            })).accessibilityIdentifier("\(id)-value-\(key)")
          } else {
            Text("Unsupported saved entry. It is retained; use Complete JSON or remove it explicitly.")
              .font(.caption).foregroundStyle(.orange)
          }
        }
        Divider()
      }
      HStack {
        TextField("Entry name", text: $newName).accessibilityIdentifier("\(id)-name")
        Button("Add entry", systemImage: "plus") {
          guard !candidate.isEmpty, values[candidate] == nil else { return }
          values[candidate] = .object(["value": .string("")]); newName = ""
        }.disabled(candidate.isEmpty || values[candidate] != nil).accessibilityIdentifier("\(id)-add")
      }
      if !candidate.isEmpty, values[candidate] != nil {
        Text("That name already exists. Choose another name to avoid replacing its value.").font(.caption).foregroundStyle(.orange)
      }
      Text("Use literal values for non-secret configuration. For secrets, enter an enrolled credential ID; availability and permission are checked by the daemon.")
        .font(.caption).foregroundStyle(.secondary)
    }
  }
}
