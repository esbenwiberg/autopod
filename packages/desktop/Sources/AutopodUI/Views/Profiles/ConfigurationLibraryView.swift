import AutopodClient
import SwiftUI

public struct ConfigurationLibraryView: View {
  public var actions: LaunchConfigurationActions
  @State private var kind: ConfigurationKind = .profile
  @State private var showWatchers = false
  @State private var showDeployments = false
  @State private var editor: EditorTarget?
  @State private var search = ""
  @State private var error: String?
  private struct EditorTarget: Identifiable { let id = UUID(); let kind: ConfigurationKind; let document: ConfigurationDocument? }
  public init(actions: LaunchConfigurationActions, initialKind: ConfigurationKind = .profile) {
    self.actions = actions
    self._kind = State(initialValue: initialKind)
  }
  public var body: some View {
    HStack(spacing: 0) {
      VStack {
        List { ForEach(ConfigurationKind.allCases) { item in
          Button { kind = item; showWatchers = false; showDeployments = false } label: { Text(item.label).frame(maxWidth: .infinity, alignment: .leading).foregroundStyle(!showWatchers && !showDeployments && kind == item ? Color.accentColor : Color.primary) }.buttonStyle(.plain)
        } }
        Button("Issue watchers") { showWatchers = true; showDeployments = false }.padding()
        Button("Deployments") { showDeployments = true; showWatchers = false }.padding()
      }.frame(width: 150)
      Divider()
      if showDeployments { DeploymentLibraryView(actions: actions) } else if showWatchers { WatcherLibraryView(actions: actions) } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack { Text(kind.label).font(.title2.bold()); Spacer(); Button("New") { editor = EditorTarget(kind: kind, document: nil) }; Button("Refresh") { Task { await actions.reload() } } }
        TextField("Search", text: $search).textFieldStyle(.roundedBorder)
        if let message = error ?? actions.loadError { Text(message).foregroundStyle(.red) }
        List(actions.list(kind).filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { document in
          HStack {
            VStack(alignment: .leading) { Text(document.name).font(.headline); Text("Revision \(document.revision) · \(usageCount(document.id)) references").font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Button("Edit") { editor = EditorTarget(kind: kind, document: document) }
            Button("Archive") { Task { do { try await actions.archive(document) } catch { self.error = error.localizedDescription } } }.disabled(usageCount(document.id) > 0)
          }.padding(.vertical, 4)
        }
        Text("Profiles combine reusable parts. Editing a shared preset changes future launches; existing pods keep their saved configuration.").font(.caption).foregroundStyle(.secondary)
      }.padding()
      }
    }.sheet(item: $editor) { target in ConfigurationEditorSheet(kind: target.kind, document: target.document, actions: actions) }
  }
  private func usageCount(_ id: String) -> Int {
    func references(_ value: ConfigurationJSON) -> Bool {
      switch value { case .string(let text): text == id; case .array(let values): values.contains(where: references); case .object(let fields): fields.values.contains(where: references); default: false }
    }
    return actions.documents.filter { !$0.archived && $0.id != id && references(.object($0.payload)) }.count
  }
}

struct ConfigurationEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  let kind: ConfigurationKind
  let document: ConfigurationDocument?
  let actions: LaunchConfigurationActions
  @State private var name: String
  @State private var payload: [String: ConfigurationJSON]
  @State private var busy = false
  @State private var error: String?
  @State private var rawJSON = ""
  @State private var showJSON = false
  @State private var showPim = false
  @State private var accounts: [PublicProviderAccountResponse] = []
  init(kind: ConfigurationKind, document: ConfigurationDocument?, actions: LaunchConfigurationActions) {
    self.kind = kind; self.document = document; self.actions = actions
    self._name = State(initialValue: document?.name ?? "")
    self._payload = State(initialValue: document?.payload ?? Self.initial(kind))
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(document == nil ? "New \(kind.label)" : "Edit \(document?.name ?? "")").font(.title2.bold())
      TextField("Name", text: $name).textFieldStyle(.roundedBorder)
      if let document { Text("Editing revision \(document.revision). Changes apply to future launches.").font(.caption).foregroundStyle(.secondary) }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          switch kind {
          case .profile: profileForm
          case .githubAccess: GitHubAccessRuleEditor(payload: $payload, actions: actions)
          case .ai: aiForm
          case .workflow: workflowForm
          case .repository: repositoryForm
          case .environment: environmentForm
          case .toolPack: toolPackForm
          }
          DisclosureGroup("Complete JSON", isExpanded: $showJSON) {
            TextEditor(text: $rawJSON).font(.system(.caption, design: .monospaced)).frame(minHeight: 220)
            HStack { Button("Load current values") { rawJSON = ConfigurationJSON.object(payload).formatted() }; Button("Apply JSON") { applyJSON() } }
            Text("All schema fields are supported. Secret values belong in credential references.").font(.caption).foregroundStyle(.secondary)
          }.onChange(of: showJSON) { _, visible in if visible { rawJSON = ConfigurationJSON.object(payload).formatted() } }
        }.padding(4)
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack { Button("Cancel") { dismiss() }; Spacer(); if busy { ProgressView().controlSize(.small) }; Button("Save") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty) }
    }.padding(24).frame(width: 760, height: 740).disabled(busy)
    .sheet(isPresented: $showPim) { PimSelectionSheet(selected: payload["pim"]?.array?.compactMap(\.object) ?? [], discover: actions.discoverPim) { payload["pim"] = .array($0.map(ConfigurationJSON.object)) } }
    .task { if kind == .ai { do { accounts = try await actions.loadProviderAccounts() } catch { self.error = error.localizedDescription } } }
  }
  private var profileForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      referencePicker(.environment, key: "environmentId")
      referencePicker(.ai, key: "aiId")
      referencePicker(.workflow, key: "workflowId")
      referencePicker(.githubAccess, key: "githubAccessId", optional: true)
      GroupBox("Tool packs") { VStack(alignment: .leading) { ForEach(actions.list(.toolPack)) { pack in
        Toggle(pack.name, isOn: Binding(get: { payload["toolPackIds"]?.array?.contains(.string(pack.id)) ?? false }, set: { enabled in
          var values = payload["toolPackIds"]?.array ?? []; values.removeAll { $0 == .string(pack.id) }; if enabled { values.append(.string(pack.id)) }; payload["toolPackIds"] = .array(values)
        }))
      } } }
      DisclosureGroup("Execution defaults") { ProfileExecutionDefaultsEditor(fields: objectBinding("execution"), capabilities: actions.capabilities) }
      Button("Choose PIM access · \(payload["pim"]?.array?.count ?? 0) selected") { showPim = true }
      referencePicker(.profile, key: "workerProfileId", optional: true)
    }
  }
  private func referencePicker(_ type: ConfigurationKind, key: String, optional: Bool = false) -> some View {
    Picker(key == "workerProfileId" ? "Workspace worker profile" : type.label, selection: Binding(get: { payload[key]?.string ?? "" }, set: { payload[key] = $0.isEmpty && optional ? .null : .string($0) })) {
      Text(optional ? "None" : "Choose preset").tag("")
      ForEach(actions.list(type).filter { $0.id != document?.id }) { Text($0.name).tag($0.id) }
    }
  }
  private var aiForm: some View {
    VStack(alignment: .leading, spacing: 14) {
      GroupBox("Main agent") { routeEditor(objectBinding("main")) }
      Picker("Reviewer", selection: Binding(get: { payload["reviewer"]?["mode"]?.string ?? "follow-main" }, set: { mode in
        payload["reviewer"] = .object(mode == "follow-main" ? ["mode": .string(mode)] : ["mode": .string(mode), "route": .object(Self.initialRoute)])
      })) { Text("Follow main").tag("follow-main"); Text("Independent account and model").tag("independent") }
      if payload["reviewer"]?["mode"]?.string == "independent" {
        GroupBox("Independent reviewer") { routeEditor(Binding(get: { payload["reviewer"]?["route"]?.object ?? [:] }, set: { payload["reviewer"] = .object(["mode": .string("independent"), "route": .object($0)]) })) }
      }
      Text("Each route owns its account, runtime, model and failover choices. Review usage counts within the whole-pod budget.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func routeEditor(_ route: Binding<[String: ConfigurationJSON]>) -> some View {
    VStack(alignment: .leading) {
      Picker("Account", selection: Binding(get: { route.wrappedValue["providerAccountId"]?.string ?? "" }, set: { route.wrappedValue["providerAccountId"] = .string($0) })) {
        Text("Choose account").tag(""); ForEach(accounts, id: \.id) { Text($0.name).tag($0.id) }
      }
      Picker("Runtime", selection: Binding(get: { route.wrappedValue["runtime"]?.string ?? "claude" }, set: { route.wrappedValue["runtime"] = .string($0) })) {
        Text("Claude").tag("claude"); Text("Codex").tag("codex"); Text("Pi").tag("pi"); Text("Copilot").tag("copilot")
      }
      TextField("Model", text: Binding(get: { route.wrappedValue["model"]?.string ?? "" }, set: { route.wrappedValue["model"] = .string($0) }))
      DisclosureGroup("Reasoning and failover") { ConfigurationFieldsEditor(fields: route, excluded: ["providerAccountId", "runtime", "model"]) }
    }.padding(6)
  }
  private var workflowForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      stringPicker("Agent mode", key: "agentMode", values: ["auto", "interactive"])
      stringPicker("Default intent", key: "intent", values: ["task", "goal"])
      stringPicker("Output", key: "output", values: ["pr", "branch", "artifact", "none"])
      stringPicker("Daemon delivery", key: "completion", values: ["approval", "deliver", "merge"])
      GroupBox("Validation") { VStack(alignment: .leading) { ForEach(["setup", "lint", "sast", "build", "test", "health", "pages", "facts", "review", "advisory"], id: \.self) { phase in
        Toggle(phase.capitalized, isOn: Binding(get: { payload["validationPhases"]?.array?.contains(.string(phase)) ?? false }, set: { enabled in var values = payload["validationPhases"]?.array ?? []; values.removeAll { $0 == .string(phase) }; if enabled { values.append(.string(phase)) }; payload["validationPhases"] = .array(values) }))
      } } }
      ConfigurationNumberValue(title: "Whole-pod token limit", fields: $payload, key: "tokenBudget", fallback: 100000, unsetLabel: "No token limit")
      ConfigurationNumberValue(title: "Reviewer token limit", fields: $payload, key: "reviewerTokenBudget", fallback: 10000, unsetLabel: "No separate limit")
      ConfigurationFieldsEditor(fields: $payload, excluded: ["agentMode", "intent", "output", "completion", "validationPhases", "tokenBudget", "reviewerTokenBudget"])
    }
  }
  private var repositoryForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      stringPicker("Source provider", key: "provider", values: ["github", "ado", "git"])
      TextField("Repository HTTPS URL", text: stringBinding("remote"))
      referencePicker(.profile, key: "usualProfileId", optional: true)
      Text("Named project setups contain commands, working directory, branches, paths and registry references.").font(.caption).foregroundStyle(.secondary)
      Picker("Default setup", selection: stringBinding("defaultSetupId")) {
        ForEach(payload["setups"]?.array?.compactMap(\.object) ?? [], id: \.["id"]) { setup in
          Text(setup["name"]?.string ?? "Unnamed setup").tag(setup["id"]?.string ?? "")
        }
      }
      ConfigurationObjectListEditor(title: "Project setups", values: arrayBinding("setups"), initial: { ["id": .string("setup-\(UUID().uuidString.prefix(8).lowercased())"), "name": .string("New setup"), "defaultBranch": .string("main")] }) { RepositorySetupEditor(fields: $0) }
      DisclosureGroup("Repository identity and trust") { ConfigurationFieldsEditor(fields: $payload, excluded: ["provider", "remote", "usualProfileId", "setups", "defaultSetupId"]) }
    }
  }
  private var environmentForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      stringPicker("Template", key: "template", values: ["node22", "node22-pw", "node22-pw-pg", "node24", "node24-pw", "dotnet9", "dotnet10", "dotnet10-go", "python312", "python-node", "python-node-pg", "go124", "go124-pw", "custom"])
      Text("Software and sidecar definitions belong here. Docker/sandbox and resource sizes are chosen by the profile or at launch.").font(.caption).foregroundStyle(.secondary)
      ConfigurationTextValue(title: "Base image (optional)", fields: $payload, key: "baseImage", optional: true)
      ConfigurationObjectListEditor(title: "Tools", values: arrayBinding("tools"), initial: { ["name": .string(""), "version": .string("")] }) { fields in
        HStack { ConfigurationTextValue(title: "Tool", fields: fields, key: "name"); ConfigurationTextValue(title: "Version", fields: fields, key: "version") }
      }
      Text("Use pnpm, playwright, npm:package or pip:package, with an exact version.").font(.caption).foregroundStyle(.secondary)
      ConfigurationStringListEditor(title: "Image preparation commands", values: arrayBinding("prepareCommands"))
      ConfigurationObjectListEditor(title: "Sidecars", values: arrayBinding("sidecars"), initial: { ["id": .string("service-\(UUID().uuidString.prefix(8).lowercased())"), "type": .string("postgres"), "image": .string(""), "version": .string(""), "startup": .string("on-demand"), "port": .number(5432)] }) { EnvironmentSidecarEditor(fields: $0) }
      ConfigurationStringListEditor(title: "Provided capabilities", values: arrayBinding("capabilities"))
    }
  }
  private var toolPackForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationObjectListEditor(title: "Instructions", values: arrayBinding("instructions"), initial: { ["heading": .string(""), "content": .string("")] }) { fields in
        VStack { ConfigurationTextValue(title: "Heading", fields: fields, key: "heading"); ConfigurationTextValue(title: "Instructions", fields: fields, key: "content", multiline: true) }
      }
      ConfigurationObjectListEditor(title: "Skills", values: arrayBinding("skills"), initial: { ["name": .string(""), "source": .object(["type": .string("builtin")])] }) { SkillSourceEditor(fields: $0, repositories: actions.list(.repository)) }
      ConfigurationObjectListEditor(title: "MCP servers", values: arrayBinding("mcpServers"), initial: { ["name": .string(""), "transport": .object(["type": .string("http"), "url": .string(""), "headers": .object([:])])] }) { McpTransportEditor(fields: $0) }
      ConfigurationStringListEditor(title: "Required capabilities", values: arrayBinding("requiredCapabilities"))
      Text("Tool packs provide tools and instructions. Access is selected separately.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func arrayBinding(_ key: String) -> Binding<[ConfigurationJSON]> { Binding(get: { payload[key]?.array ?? [] }, set: { payload[key] = .array($0) }) }
  private func objectBinding(_ key: String) -> Binding<[String: ConfigurationJSON]> { Binding(get: { payload[key]?.object ?? [:] }, set: { payload[key] = .object($0) }) }
  private func stringBinding(_ key: String) -> Binding<String> { Binding(get: { payload[key]?.string ?? "" }, set: { payload[key] = .string($0) }) }
  private func stringPicker(_ title: String, key: String, values: [String]) -> some View { Picker(title, selection: stringBinding(key)) { ForEach(values, id: \.self) { Text($0.capitalized).tag($0) } } }
  private func applyJSON() { do { guard let fields = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(rawJSON.utf8)).object else { throw LaunchJSONError.invalid("Preset payload must be an object") }; payload = fields; error = nil } catch { self.error = error.localizedDescription } }
  private func save() async { busy = true; defer { busy = false }; do { _ = try await actions.save(kind, ConfigurationWriteRequest(id: document?.id, name: name, payload: payload, expectedRevision: document?.revision)); dismiss() } catch { self.error = error.localizedDescription } }
  private static var initialRoute: [String: ConfigurationJSON] { ["providerAccountId": .string(""), "runtime": .string("claude"), "model": .string(""), "reasoningEffort": .string("auto"), "failover": .array([]), "maxHops": .number(0)] }
  private static func initial(_ kind: ConfigurationKind) -> [String: ConfigurationJSON] {
    switch kind {
    case .profile: ["environmentId": .string(""), "aiId": .string(""), "workflowId": .string(""), "githubAccessId": .null, "toolPackIds": .array([]), "execution": .object(["target": .string("local"), "main": .object(["memoryGb": .null, "cpus": .null, "storageGb": .null]), "sidecars": .object([:])]), "pim": .array([]), "workerProfileId": .null]
    case .githubAccess: ["rules": .array([])]
    case .ai: ["main": .object(initialRoute), "reviewer": .object(["mode": .string("follow-main")])]
    case .workflow: ["agentMode": .string("auto"), "intent": .string("task"), "output": .string("pr"), "completion": .string("approval"), "validationPhases": .array(["setup", "build", "test", "review"].map(ConfigurationJSON.string)), "tokenBudget": .null, "reviewerTokenBudget": .null]
    case .repository: ["provider": .string("github"), "remote": .string(""), "providerRepositoryId": .null, "usualProfileId": .null, "setups": .array([.object(["id": .string("default"), "name": .string("Default"), "defaultBranch": .string("main"), "buildCommand": .null, "testCommand": .null])]), "defaultSetupId": .string("default"), "trustedSetupIds": .array([])]
    case .environment: ["template": .string("node22"), "baseImage": .null, "tools": .array([]), "prepareCommands": .array([]), "capabilities": .array([]), "sidecars": .array([])]
    case .toolPack: ["instructions": .array([]), "skills": .array([]), "mcpServers": .array([]), "requiredCapabilities": .array([])]
    }
  }
}

/// Unknown/new nested fields remain in the document. The daemon remains the schema authority.
struct ConfigurationFieldsEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  var excluded: Set<String> = []
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(fields.keys.filter { !excluded.contains($0) }.sorted(), id: \.self) { key in
        if let value = fields[key] { field(key, value) }
      }
    }
  }
  private func field(_ key: String, _ value: ConfigurationJSON) -> AnyView {
    let title = key.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized
    switch value {
    case .bool: return AnyView(Toggle(title, isOn: Binding(get: { fields[key]?.bool ?? false }, set: { fields[key] = .bool($0) })))
    case .string: return AnyView(TextField(title, text: Binding(get: { fields[key]?.string ?? "" }, set: { fields[key] = .string($0) })))
    case .object: return AnyView(DisclosureGroup(title) { ConfigurationFieldsEditor(fields: Binding(get: { fields[key]?.object ?? [:] }, set: { fields[key] = .object($0) })) })
    default: return AnyView(ConfigurationJSONField(title: title, value: Binding(get: { fields[key] ?? .null }, set: { fields[key] = $0 })))
    }
  }
}
private struct ConfigurationJSONField: View {
  let title: String
  @Binding var value: ConfigurationJSON
  @State private var text = ""
  @State private var error: String?
  var body: some View {
    DisclosureGroup(title) {
      VStack(alignment: .leading) {
        TextEditor(text: $text).font(.system(.caption, design: .monospaced)).frame(minHeight: 55, maxHeight: 150)
        HStack { Button("Apply") { do { value = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(text.utf8)); error = nil } catch { self.error = error.localizedDescription } }; if let error { Text(error).font(.caption).foregroundStyle(.red) } }
      }
    }.onAppear { text = value.formatted() }.onChange(of: value) { _, latest in text = latest.formatted() }
  }
}
