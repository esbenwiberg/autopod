import AutopodClient
import SwiftUI

struct WatcherLibraryView: View {
  @Environment(\.desktopRedesign) private var redesign
  let actions: LaunchConfigurationActions
  @State private var items: [WatcherBindingResponse] = []
  @State private var error: String?
  @State private var loading = false
  @State private var editor: Editor?
  private struct Editor: Identifiable { let id = UUID(); let item: WatcherBindingResponse? }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if redesign { Text("AUTOMATION / ISSUE ROUTING").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary) }
      HStack { Text("Issue watchers").font(.title2.bold()); Spacer(); Button("New watcher") { editor = Editor(item: nil) }; Button("Refresh") { Task { await load() } }.disabled(loading) }
      Text("Choose the repository and configuration for new issues. Planning keeps a saved copy of the implementation settings.").foregroundStyle(.secondary)
      if let error { Text(error).foregroundStyle(.red) }
      if redesign {
        if items.isEmpty && !loading {
          ContentUnavailableView("No issue watchers", systemImage: "eye", description: Text("Create a watcher to route new issues into a saved launch configuration."))
        } else {
          ScrollView {
            LazyVStack(spacing: 10) {
              ForEach(items) { item in
                HStack(spacing: 16) {
                  Image(systemName: "eye").font(.title3).foregroundStyle(DesktopTheme.accent)
                    .frame(width: 40, height: 40).background(DesktopTheme.selection, in: RoundedRectangle(cornerRadius: 8))
                  VStack(alignment: .leading, spacing: 6) {
                    Text(item.name).font(.headline)
                    Text("Label \(item.payload["labelPrefix"]?.string ?? "autopod") · Revision \(item.revision)")
                      .font(.caption).foregroundStyle(.secondary)
                  }
                  Spacer()
                  Text(item.payload["enabled"]?.bool == true ? "Enabled" : "Paused")
                    .font(.caption).foregroundStyle(item.payload["enabled"]?.bool == true ? DesktopTheme.accent : .secondary)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(DesktopTheme.canvas, in: Capsule())
                  Button("Edit") { editor = Editor(item: item) }
                }.desktopFormSection()
              }
            }.padding(1)
          }
        }
      } else {
        List(items) { item in
          HStack { VStack(alignment: .leading) { Text(item.name).font(.headline); Text("\(item.payload["enabled"]?.bool == true ? "Enabled" : "Paused") · \(item.payload["labelPrefix"]?.string ?? "autopod") · revision \(item.revision)").font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Edit") { editor = Editor(item: item) } }
        }
      }
    }.padding(redesign ? 26 : 16).background(redesign ? DesktopTheme.canvas : .clear).task { await load() }
      .sheet(item: $editor, onDismiss: { Task { await load() } }) { target in WatcherEditorView(actions: actions, item: target.item) }
  }
  private func load() async { loading = true; defer { loading = false }; do { items = try await actions.listWatchers(); error = nil } catch { self.error = error.localizedDescription } }
}

struct WatcherEditorView: View {
  @Environment(\.desktopRedesign) private var redesign
  @Environment(\.dismiss) private var dismiss
  let actions: LaunchConfigurationActions
  let item: WatcherBindingResponse?
  @State private var payload: [String: ConfigurationJSON]
  @State private var newLabel = ""
  @State private var newProfile = ""
  @State private var rawJSON = ""
  @State private var error: String?
  @State private var busy = false
  init(actions: LaunchConfigurationActions, item: WatcherBindingResponse?) {
    self.actions = actions; self.item = item
    _payload = State(initialValue: item?.payload ?? ["name": .string(""), "enabled": .bool(false), "labelPrefix": .string("autopod"), "launch": .object([:]), "targets": .object([:])])
  }
  private var launch: [String: ConfigurationJSON] { payload["launch"]?.object ?? [:] }
  private var repositoryId: String { launch["repositoryId"]?.string ?? "" }
  private var targets: [String: ConfigurationJSON] { payload["targets"]?.object ?? [:] }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if !redesign { Text(item == nil ? "New issue watcher" : "Edit issue watcher").font(.title2.bold()) }
      ScrollView { VStack(alignment: .leading, spacing: 12) {
        TextField("Name", text: text("name"))
        Toggle("Enabled", isOn: Binding(get: { payload["enabled"]?.bool ?? false }, set: { payload["enabled"] = .bool($0) }))
        TextField("Issue label prefix", text: text("labelPrefix"))
        Picker("Repository", selection: Binding(get: { repositoryId }, set: { id in var next = launch; next["repositoryId"] = .string(id); next.removeValue(forKey: "repositorySetupId"); payload["launch"] = .object(next); payload["targets"] = .object([:]) })) {
          Text("Choose repository").tag(""); ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
        }
        Picker("Profile", selection: Binding(get: { launch["profileId"]?.string ?? "" }, set: { id in var next = launch; if id.isEmpty { next.removeValue(forKey: "profileId") } else { next["profileId"] = .string(id) }; payload["launch"] = .object(next) })) {
          Text("Repository usual profile").tag(""); ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
        }
        Text("The plain label starts planning. The :artifact label creates an artifact. Add named labels for other configurations in this repository.").font(.caption).foregroundStyle(.secondary)
        GroupBox("Named label routes") { VStack {
          ForEach(targets.keys.sorted(), id: \.self) { label in HStack { Text("\(payload["labelPrefix"]?.string ?? "autopod"):\(label)"); Spacer(); Text(profileLabel(targets[label]?["profileId"]?.string)); Button("Remove") { var next = targets; next.removeValue(forKey: label); payload["targets"] = .object(next) } } }
          HStack { TextField("Label suffix", text: $newLabel); Picker("Profile", selection: $newProfile) { Text("Repository usual profile").tag(""); ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) } }; Button("Add") { var target: [String: ConfigurationJSON] = ["repositoryId": .string(repositoryId)]; if !newProfile.isEmpty { target["profileId"] = .string(newProfile) }; var next = targets; next[newLabel.trimmingCharacters(in: .whitespaces)] = .object(target); payload["targets"] = .object(next); newLabel = "" }.disabled(repositoryId.isEmpty || newLabel.trimmingCharacters(in: .whitespaces).isEmpty) }
        } }
        DisclosureGroup("Advanced launch choices and overrides") {
          TextEditor(text: $rawJSON).font(.system(.caption, design: .monospaced)).frame(minHeight: 150)
          Button("Apply JSON") { do { guard let value = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(rawJSON.utf8)).object else { throw DaemonError.badRequest("Watcher payload must be an object") }; payload = value; error = nil } catch { self.error = error.localizedDescription } }
        }
      }.desktopFormSection() }
      if let error { Text(error).foregroundStyle(.red) }
      HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Save") { Task { await save() } }.disabled(busy || repositoryId.isEmpty || (payload["name"]?.string ?? "").isEmpty) }.desktopDialogActions()
    }
    .desktopDialog(item == nil ? "New issue watcher" : "Edit issue watcher", eyebrow: "Automation / Issue routing",
      subtitle: "Choose the repository, default profile and label routes for incoming issues.",
      width: 820, height: 740, legacyWidth: 720, legacyHeight: 620, legacyPadding: 24)
    .groupBoxStyle(DesktopGroupBoxStyle()).disabled(busy)
      .onAppear { rawJSON = ConfigurationJSON.object(payload).formatted() }
      .onChange(of: payload) { _, value in rawJSON = ConfigurationJSON.object(value).formatted() }
  }
  private func text(_ key: String) -> Binding<String> { Binding(get: { payload[key]?.string ?? "" }, set: { payload[key] = .string($0) }) }
  private func profileLabel(_ id: String?) -> String { guard let id else { return "Repository usual profile" }; return actions.list(.profile).first { $0.id == id }?.name ?? id }
  private func save() async { busy = true; defer { busy = false }; do { _ = try await actions.saveWatcher(WatcherBindingWrite(id: item?.id, expectedRevision: item?.revision, payload: payload)); dismiss() } catch { self.error = error.localizedDescription } }
}
