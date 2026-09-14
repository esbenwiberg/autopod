import AutopodClient
import SwiftUI

/// Schedules keep choices, while each run receives its own immutable resolved configuration.
struct ScheduledLaunchSelectionEditor: View {
  let actions: LaunchConfigurationActions
  @Binding var selection: [String: ConfigurationJSON]
  let task: String
  var repositoryLocked = false
  @State private var showPim = false
  @State private var advanced = ""
  @State private var error: String?
  @State private var preview: EffectiveLaunchPreview?
  @State private var resolving = false

  private var repository: ConfigurationDocument? {
    actions.list(.repository).first { $0.id == selection["repositoryId"]?.string }
  }
  private var selectedProfile: ConfigurationDocument? {
    let id = selection["profileId"]?.string ?? repository?.payload["usualProfileId"]?.string
    return actions.list(.profile).first { $0.id == id }
  }
  private var selections: [String: ConfigurationJSON] { selection["selections"]?.object ?? [:] }
  private var overrides: [String: ConfigurationJSON] { selection["overrides"]?.object ?? [:] }
  private var pim: [[String: ConfigurationJSON]] {
    (overrides["pim"]?.array ?? selectedProfile?.payload["pim"]?.array ?? []).compactMap { $0.object }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("Repository", selection: Binding(get: {
        selection["emptyWorkspace"]?.bool == true ? "__empty" : selection["repositoryId"]?.string ?? ""
      }, set: { id in
        selection.removeValue(forKey: "repositorySetupId")
        selection.removeValue(forKey: "repositoryId")
        selection.removeValue(forKey: "emptyWorkspace")
        var edited = overrides; edited.removeValue(forKey: "repositorySetup"); selection["overrides"] = .object(edited)
        if id == "__empty" { selection["emptyWorkspace"] = .bool(true) }
        else if !id.isEmpty { selection["repositoryId"] = .string(id) }
      })) {
        Text("Select repository").tag("")
        Text("Empty workspace").tag("__empty")
        ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
      }.disabled(repositoryLocked)
      if let repository {
        Picker("Repository setup", selection: topLevel("repositorySetupId")) {
          Text("Repository default").tag("")
          ForEach(repository.payload["setups"]?.array ?? [], id: \.self) { setup in
            Text(setup["name"]?.string ?? "Setup").tag(setup["id"]?.string ?? "")
          }
        }
      }
      Picker("Profile", selection: topLevel("profileId")) {
        Text("Repository usual profile").tag("")
        ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
      }
      preset(.environment, key: "environmentId", label: "Environment")
      preset(.ai, key: "aiId", label: "AI setup")
      preset(.workflow, key: "workflowId", label: "Workflow")
      preset(.githubAccess, key: "githubAccessId", label: "GitHub access", allowNone: true)
      DisclosureGroup("Tool packs") {
        Toggle("Use profile tool packs", isOn: Binding(get: { selections["toolPackIds"] == nil }, set: { useDefault in
          var next = selections
          if useDefault { next.removeValue(forKey: "toolPackIds") }
          else { next["toolPackIds"] = selectedProfile?.payload["toolPackIds"] ?? .array([]) }
          selection["selections"] = .object(next)
        }))
        if selections["toolPackIds"] != nil {
          ForEach(actions.list(.toolPack)) { pack in
            Toggle(pack.name, isOn: Binding(get: { selections["toolPackIds"]?.array?.contains(.string(pack.id)) == true }, set: { enabled in
              var ids = selections["toolPackIds"]?.array ?? []
              ids.removeAll { $0 == .string(pack.id) }
              if enabled { ids.append(.string(pack.id)) }
              var next = selections; next["toolPackIds"] = .array(ids); selection["selections"] = .object(next)
              var edited = overrides; edited.removeValue(forKey: "toolPacks"); selection["overrides"] = .object(edited)
            }))
          }
        }
      }
      HStack {
        Button("Choose PIM access (\(pim.count))") { showPim = true }
        if overrides["pim"] != nil {
          Button("Use profile PIM") { var next = overrides; next.removeValue(forKey: "pim"); selection["overrides"] = .object(next) }
        }
      }
      Text("Preset edits apply to future runs. A run already admitted keeps its configuration.")
        .font(.caption).foregroundStyle(.secondary)
      DisclosureGroup("Advanced selection JSON") {
        Text("Allocation, sidecars, individual overrides and reference repositories.").font(.caption)
        TextEditor(text: $advanced).font(.system(.caption, design: .monospaced)).frame(height: 160)
        Button("Apply JSON") {
          do {
            let parsed = try JSONDecoder().decode([String: ConfigurationJSON].self, from: Data(advanced.utf8))
            guard Set(parsed.keys).isDisjoint(with: ["task", "work", "requestId", "expectedDigest", "origin"]) else {
              throw NSError(domain: "Schedule", code: 1, userInfo: [NSLocalizedDescriptionKey: "Task and run identity belong to the scheduled run."])
            }
            selection = parsed; error = nil
          } catch { self.error = error.localizedDescription }
        }
      }
      Button(resolving ? "Checking…" : "Preview configuration") {
        resolving = true
        Task {
          defer { resolving = false }
          do {
            var value = selection; value["task"] = .string(task)
            let request = try JSONDecoder().decode(ComposableLaunchRequest.self, from: JSONEncoder().encode(value))
            let decoded = try JSONDecoder().decode([String: ConfigurationJSON].self, from: JSONEncoder().encode(request))
            guard value == decoded else {
              throw NSError(domain: "Schedule", code: 2, userInfo: [NSLocalizedDescriptionKey: "This selection contains fields the desktop cannot preview. Review the JSON before saving."])
            }
            preview = try await actions.resolve(request); error = nil
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(resolving || task.isEmpty)
      if let error { Text(error).foregroundStyle(.red).font(.caption) }
      if let preview {
        Text("Ready: \(preview.fields["execution"]?["target"]?.string ?? "execution selected") · \(preview.fields["ai"]?["main"]?["model"]?.string ?? "AI selected")")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .onAppear { advanced = ConfigurationJSON.object(selection).formatted() }
    .onChange(of: selection) { _, value in advanced = ConfigurationJSON.object(value).formatted(); preview = nil }
    .sheet(isPresented: $showPim) {
      PimSelectionSheet(selected: pim, discover: actions.discoverPim) { values in
        var next = overrides; next["pim"] = .array(values.map(ConfigurationJSON.object)); selection["overrides"] = .object(next)
      }
    }
  }
  private func topLevel(_ key: String) -> Binding<String> {
    Binding(get: { selection[key]?.string ?? "" }, set: { value in
      if value.isEmpty { selection.removeValue(forKey: key) } else { selection[key] = .string(value) }
    })
  }
  private func preset(_ kind: ConfigurationKind, key: String, label: String, allowNone: Bool = false) -> some View {
    Picker(label, selection: Binding(get: {
      selections[key] == .null ? "__none" : selections[key]?.string ?? ""
    }, set: { value in
      var next = selections
      if value.isEmpty { next.removeValue(forKey: key) }
      else { next[key] = value == "__none" ? .null : .string(value) }
      selection["selections"] = .object(next)
      var edited = overrides; edited.removeValue(forKey: kind.rawValue); selection["overrides"] = .object(edited)
      if kind == .environment { selection.removeValue(forKey: "requiredSidecarIds") }
    })) {
      Text("Profile default").tag("")
      if allowNone { Text("No access").tag("__none") }
      ForEach(actions.list(kind)) { Text($0.name).tag($0.id) }
    }
  }
}
