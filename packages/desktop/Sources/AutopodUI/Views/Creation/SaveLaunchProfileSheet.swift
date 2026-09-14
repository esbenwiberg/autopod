import AutopodClient
import SwiftUI

struct SaveLaunchProfileSheet: View {
  @Environment(\.dismiss) private var dismiss
  let request: ComposableLaunchRequest
  let preview: EffectiveLaunchPreview
  let actions: LaunchConfigurationActions
  let onSaved: (String) -> Void
  @State private var name = ""
  @State private var presetNames: [String: String] = [:]
  @State private var proposal: ConfigurationJSON?
  @State private var busy = false
  @State private var error: String?

  private let categories = ["environment", "ai", "workflow", "githubAccess"]
  private var toolCount: Int { preview.fields["toolPacks"]?.array?.count ?? 0 }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Save this combination as a profile").font(.title2.bold())
      Text("Unchanged presets are reused. Edited parts become new presets, with the names shown below.")
        .foregroundStyle(.secondary)
      TextField("Profile name", text: $name).textFieldStyle(.roundedBorder)
      DisclosureGroup("Names for edited presets") {
        VStack(alignment: .leading) {
          ForEach(categories, id: \.self) { category in
            TextField(category, text: nameBinding(category))
          }
          ForEach(0..<toolCount, id: \.self) { index in
            TextField("Tool pack \(index + 1)", text: nameBinding("toolPack-\(index)"))
          }
        }.padding(.top, 8)
      }
      if let proposal {
        Text("The following configurations will be created:").font(.headline)
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array((proposal["writes"]?.array ?? []).enumerated()), id: \.offset) { _, write in
              Text("\(write["kind"]?.string ?? "Configuration") · \(write["name"]?.string ?? "")")
            }
            DisclosureGroup("Review complete values") {
              Text(proposal.formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
          }
        }.frame(maxHeight: 250)
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack {
        Button("Cancel") { dismiss() }.disabled(busy)
        if busy { ProgressView().controlSize(.small) }
        Spacer()
        Button("Review changes") { Task { await submit(save: false) } }
          .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("Save profile") { Task { await submit(save: true) } }
          .buttonStyle(.borderedProminent).disabled(busy || proposal == nil)
      }
    }
    .padding(24).frame(width: 620)
    .onChange(of: name) { _, _ in proposal = nil }
    .onChange(of: presetNames) { _, _ in proposal = nil }
  }

  private func nameBinding(_ key: String) -> Binding<String> {
    Binding(get: { presetNames[key] ?? "" }, set: { presetNames[key] = $0 })
  }

  private func submit(save: Bool) async {
    busy = true; error = nil
    defer { busy = false }
    do {
      let profileName = name.trimmingCharacters(in: .whitespacesAndNewlines)
      func presetName(_ key: String) -> ConfigurationJSON {
        let supplied = presetNames[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .string(supplied.isEmpty ? "\(profileName) · \(key)" : supplied)
      }
      var names: [String: ConfigurationJSON] = ["profile": .string(profileName)]
      for category in categories { names[category] = presetName(category) }
      names["toolPacks"] = .array((0..<toolCount).map { presetName("toolPack-\($0)") })
      let launch = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))
      var body: [String: ConfigurationJSON] = ["launch": launch, "names": .object(names), "mode": .string(save ? "save" : "preview")]
      if save {
        guard let digest = proposal?["digest"]?.string else { return }
        body["expectedDigest"] = .string(digest)
      }
      let result = try await actions.saveFromLaunch(.object(body))
      if save {
        guard let id = result["id"]?.string else { throw LaunchJSONError.invalid("Saved profile response has no ID") }
        await actions.reload()
        onSaved(id)
        dismiss()
      } else { proposal = result }
    } catch { self.error = error.localizedDescription }
  }
}
