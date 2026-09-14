import AutopodClient
import SwiftUI

extension ConfigurationDocument {
  var libraryTitle: String {
    guard kind == .repository, name.contains("://"),
          let url = URL(string: name) else { return name }
    let component = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
    return component.hasSuffix(".git") ? String(component.dropLast(4)) : component
  }
}

struct ConfigurationSection<Content: View>: View {
  let title: String
  var subtitle: String = ""
  @ViewBuilder var content: () -> Content
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.headline)
        if !subtitle.isEmpty { Text(subtitle).font(.callout).foregroundStyle(.secondary) }
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(.background, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
  }
}

struct ConfigurationCapabilitiesEditor: View {
  @Binding var values: [ConfigurationJSON]
  @State private var custom = ""
  private let suggestions = ["node", "python", "dotnet", "go", "pnpm", "playwright"]
  var body: some View {
    ConfigurationSection(title: "Provided capabilities", subtitle: "Declare what this image already provides. These labels match tool-pack requirements; selecting one does not install software.") {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], alignment: .leading, spacing: 10) {
        ForEach(Array(Set(suggestions + values.compactMap(\.string))).sorted(), id: \.self) { capability in
          Toggle(capability, isOn: Binding(get: { values.contains(.string(capability)) }, set: { enabled in
            values.removeAll { $0 == .string(capability) }
            if enabled { values.append(.string(capability)) }
          }))
        }
      }
      HStack {
        TextField("Custom capability", text: $custom)
        Button("Add") {
          let value = custom.trimmingCharacters(in: .whitespacesAndNewlines)
          if !value.isEmpty && !values.contains(.string(value)) { values.append(.string(value)) }
          custom = ""
        }.disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }
}

struct ConfigurationAgentTargetEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  let accounts: [PublicProviderAccountResponse]
  private func text(_ key: String, fallback: String = "") -> Binding<String> {
    Binding(get: { fields[key]?.string ?? fallback }, set: { fields[key] = .string($0) })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("Provider account", selection: text("providerAccountId")) {
        Text("Choose account").tag("")
        ForEach(accounts, id: \.id) { Text($0.name).tag($0.id) }
        if let selected = fields["providerAccountId"]?.string, !selected.isEmpty, !accounts.contains(where: { $0.id == selected }) {
          Text("Saved account · \(selected)").tag(selected)
        }
      }
      Picker("Runtime", selection: text("runtime", fallback: "claude")) {
        Text("Claude").tag("claude"); Text("Codex").tag("codex")
        Text("Pi").tag("pi"); Text("Copilot").tag("copilot")
      }
      ConfigurationTextValue(title: "Model", fields: $fields, key: "model")
      Picker("Reasoning effort", selection: text("reasoningEffort", fallback: "auto")) {
        ForEach(["auto", "low", "medium", "high", "xhigh"], id: \.self) { Text($0.capitalized).tag($0) }
      }
    }
  }
}
