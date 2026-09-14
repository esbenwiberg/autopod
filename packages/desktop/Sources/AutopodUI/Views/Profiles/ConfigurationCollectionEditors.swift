import AutopodClient
import SwiftUI

struct ConfigurationStringListEditor: View {
  let title: String
  @Binding var values: [ConfigurationJSON]
  var body: some View {
    GroupBox(title) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(values.indices, id: \.self) { index in
          HStack {
            TextField("Value", text: Binding(get: { values.indices.contains(index) ? values[index].string ?? "" : "" }, set: { if values.indices.contains(index) { values[index] = .string($0) } }))
            Button("Remove", systemImage: "minus.circle") { values.remove(at: index) }.labelStyle(.iconOnly)
          }
        }
        Button("Add", systemImage: "plus") { values.append(.string("")) }
      }.padding(6)
    }
  }
}

struct ConfigurationObjectListEditor<Row: View>: View {
  let title: String
  @Binding var values: [ConfigurationJSON]
  let initial: () -> [String: ConfigurationJSON]
  @ViewBuilder var row: (Binding<[String: ConfigurationJSON]>) -> Row
  var body: some View {
    GroupBox(title) {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(values.indices, id: \.self) { index in
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text("\(index + 1)").font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Move up", systemImage: "arrow.up") { values.swapAt(index, index - 1) }.labelStyle(.iconOnly).disabled(index == 0)
              Button("Remove", systemImage: "minus.circle") { values.remove(at: index) }.labelStyle(.iconOnly)
            }
            row(Binding(get: { values.indices.contains(index) ? values[index].object ?? [:] : [:] }, set: { if values.indices.contains(index) { values[index] = .object($0) } }))
          }
          Divider()
        }
        Button("Add", systemImage: "plus") { values.append(.object(initial())) }
      }.padding(6)
    }
  }
}

struct ConfigurationTextValue: View {
  let title: String
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  var optional = false
  var multiline = false
  private var text: Binding<String> { Binding(get: { fields[key]?.string ?? "" }, set: { fields[key] = optional && $0.isEmpty ? .null : .string($0) }) }
  var body: some View {
    if multiline {
      VStack(alignment: .leading) { Text(title).font(.caption); TextEditor(text: text).font(.system(.body, design: .monospaced)).frame(minHeight: 80) }
    } else { TextField(title, text: text).textFieldStyle(.roundedBorder) }
  }
}

struct ConfigurationNumberValue: View {
  let title: String
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  var fallback: Double = 1
  var unsetLabel = "Default"
  var body: some View {
    HStack {
      Toggle(title, isOn: Binding(get: { fields[key]?.number != nil }, set: { fields[key] = $0 ? .number(fallback) : .null }))
      if fields[key]?.number != nil {
        TextField(title, value: Binding(get: { fields[key]?.number ?? fallback }, set: { fields[key] = .number($0) }), format: .number).frame(width: 120)
      } else { Text(unsetLabel).font(.caption).foregroundStyle(.secondary) }
    }
  }
}

struct ProfileExecutionDefaultsEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  let capabilities: ConfigurationJSON
  private var target: String { fields["target"]?.string ?? "local" }
  private var backend: ConfigurationJSON? { capabilities["execution"]?.array?.first { $0["target"]?.string == target } }
  private var main: Binding<[String: ConfigurationJSON]> { Binding(get: { fields["main"]?.object ?? [:] }, set: { fields["main"] = .object($0) }) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Picker("Run in", selection: Binding(get: { target }, set: {
        fields["target"] = .string($0)
        if $0 == "sandbox" { main.wrappedValue["cpus"] = .null; main.wrappedValue["storageGb"] = .null }
      })) { Text("Docker").tag("local"); Text("Hosted sandbox").tag("sandbox") }
      if let tiers = backend?["memoryTiersGb"]?.array?.compactMap(\.number) {
        Picker("Memory", selection: Binding(get: { main.wrappedValue["memoryGb"]?.number ?? 0 }, set: { main.wrappedValue["memoryGb"] = $0 == 0 ? .null : .number($0) })) {
          Text("Backend default").tag(0.0)
          ForEach(tiers, id: \.self) { Text("\($0.formatted()) GB").tag($0) }
          if let current = main.wrappedValue["memoryGb"]?.number, !tiers.contains(current) { Text("\(current.formatted()) GB · unavailable").tag(current) }
        }
      } else { ConfigurationNumberValue(title: "Memory (GB)", fields: main, key: "memoryGb", fallback: 4) }
      if target == "local" { ConfigurationNumberValue(title: "CPUs", fields: main, key: "cpus", fallback: 2) }
      if let reason = backend?["unavailableReason"]?.string { Text(reason).font(.caption).foregroundStyle(.secondary) }
      Text("These are launch defaults. The daemon checks the selected backend's capacity before starting a pod.").font(.caption).foregroundStyle(.secondary)
      DisclosureGroup("Network and sidecar allocations") { ConfigurationFieldsEditor(fields: $fields, excluded: ["target", "main"]) }
    }
  }
}

struct RepositorySetupEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private var deployment: Binding<[String: ConfigurationJSON]> {
    Binding(get: { fields["integrations"]?["deployment"]?.object ?? ["enabled": .bool(false), "source": .string("published-default"), "env": .object([:]), "allowedScripts": .array([])] }, set: { value in
      var integrations = fields["integrations"]?.object ?? [:]; integrations["deployment"] = .object(value); fields["integrations"] = .object(integrations)
    })
  }
  private var serviceRules: Binding<[ConfigurationJSON]> {
    Binding(get: { fields["integrations"]?["serviceAccess"]?.array ?? [] }, set: { value in
      var integrations = fields["integrations"]?.object ?? [:]
      integrations["serviceAccess"] = .array(value)
      fields["integrations"] = .object(integrations)
    })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack { ConfigurationTextValue(title: "Setup ID", fields: $fields, key: "id"); ConfigurationTextValue(title: "Name", fields: $fields, key: "name") }
      ConfigurationTextValue(title: "Default branch", fields: $fields, key: "defaultBranch", optional: true)
      ConfigurationTextValue(title: "Working directory", fields: $fields, key: "buildWorkDir", optional: true)
      ForEach([("validationSetupCommand", "Setup command"), ("buildCommand", "Build command"), ("testCommand", "Test command"), ("lintCommand", "Lint command"), ("startCommand", "Start command")], id: \.0) { key, title in
        ConfigurationTextValue(title: title, fields: $fields, key: key, optional: true)
      }
      ConfigurationObjectListEditor(title: "ADO and Azure log access", values: serviceRules, initial: {
        ["id": .string("access-\(UUID().uuidString.prefix(8).lowercased())"), "service": .string("ado"), "organization": .string(""), "project": .string(""), "repository": .string(""), "operations": .array([.string("code.file")])]
      }) { ServiceAccessRuleEditor(fields: $0) }
      DisclosureGroup("Deployment") { RepositoryDeploymentEditor(fields: deployment) }
      DisclosureGroup("Timeouts, paths and integrations") { ConfigurationFieldsEditor(fields: $fields, excluded: ["id", "name", "defaultBranch", "buildWorkDir", "validationSetupCommand", "buildCommand", "testCommand", "lintCommand", "startCommand"]) }
    }
  }
}

struct RepositoryDeploymentEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Toggle("Allow deployment requests", isOn: Binding(get: { fields["enabled"]?.bool ?? false }, set: { fields["enabled"] = .bool($0); fields["source"] = .string("published-default") }))
      Text("Source: latest published default branch. Every deployment pins a commit and requires your approval.").font(.caption).foregroundStyle(.secondary)
      if fields["enabled"]?.bool == true {
        ConfigurationTextValue(title: "Deployment target", fields: $fields, key: "targetId")
        Text("Use a target enrolled on the daemon for this repository and setup.").font(.caption).foregroundStyle(.secondary)
        ConfigurationStringListEditor(title: "Allowed scripts", values: Binding(get: { fields["allowedScripts"]?.array ?? [] }, set: { fields["allowedScripts"] = .array($0) }))
        DisclosureGroup("Environment and credential references") { ConfigurationFieldsEditor(fields: $fields, excluded: ["enabled", "source", "targetId", "allowedScripts"]) }
      }
    }
  }
}

struct ServiceAccessRuleEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private func text(_ key: String, optional: Bool = false) -> Binding<String> {
    Binding(get: { fields[key]?.string ?? "" }, set: { value in
      if optional && value.isEmpty { fields.removeValue(forKey: key) } else { fields[key] = .string(value) }
    })
  }
  private func enabled(_ key: String, _ value: String) -> Binding<Bool> {
    Binding(get: { fields[key]?.array?.contains(.string(value)) ?? false }, set: { selected in
      var values = fields[key]?.array ?? []
      values.removeAll { $0 == .string(value) }
      if selected { values.append(.string(value)) }
      fields[key] = .array(values)
    })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Picker("Service", selection: Binding(get: { fields["service"]?.string ?? "ado" }, set: { service in
        let id = fields["id"] ?? .string("access-\(UUID().uuidString.prefix(8).lowercased())")
        fields = service == "ado"
          ? ["id": id, "service": .string(service), "organization": .string(""), "project": .string(""), "operations": .array([.string("workitem.read")])]
          : ["id": id, "service": .string(service), "workspaceId": .string(""), "tables": .array([.string("ContainerAppConsoleLogs_CL")])]
      })) {
        Text("Azure DevOps").tag("ado")
        Text("Azure logs").tag("azure-logs")
      }
      if fields["service"]?.string == "azure-logs" {
        TextField("Log Analytics workspace ID", text: text("workspaceId"))
        TextField("Container app (optional)", text: text("containerApp", optional: true))
        ForEach(["ContainerAppConsoleLogs_CL", "ContainerAppSystemLogs_CL", "AzureDiagnostics", "AppTraces", "AppExceptions", "AppRequests"], id: \.self) { table in
          Toggle(table, isOn: enabled("tables", table))
        }
        Text("The pod can read these tables and filter by literal text. Selecting a container app restricts reads to its container log tables. PIM activation is selected separately.").font(.caption).foregroundStyle(.secondary)
      } else {
        TextField("Organization", text: text("organization"))
        TextField("Project", text: text("project"))
        TextField("Repository (required for code and PRs)", text: text("repository", optional: true))
        ForEach([("code.file", "Read files"), ("code.search", "Search code"), ("pr.read", "Read PRs"), ("pr.threads", "Read PR comments"), ("pr.changes", "Read PR changes"), ("workitem.read", "Read work items"), ("workitem.search", "Search work items")], id: \.0) { operation, label in
          Toggle(label, isOn: enabled("operations", operation))
        }
        Text("Each rule grants only the selected reads in this project and repository. Credentials stay with the daemon.").font(.caption).foregroundStyle(.secondary)
      }
    }.textFieldStyle(.roundedBorder)
  }
}

struct EnvironmentSidecarEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private func selection(_ key: String, fallback: String) -> Binding<String> { Binding(get: { fields[key]?.string ?? fallback }, set: { fields[key] = .string($0) }) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ConfigurationTextValue(title: "Instance ID", fields: $fields, key: "id")
      Picker("Service", selection: selection("type", fallback: "postgres")) {
        Text("PostgreSQL").tag("postgres"); Text("Redis").tag("redis"); Text("Dagger").tag("dagger-engine")
      }.onChange(of: fields["type"]) { _, value in
        fields["port"] = .number(value?.string == "redis" ? 6379 : value?.string == "dagger-engine" ? 8080 : 5432)
      }
      ConfigurationTextValue(title: "Image pinned by digest", fields: $fields, key: "image")
      ConfigurationTextValue(title: "Version", fields: $fields, key: "version")
      Picker("Start", selection: selection("startup", fallback: "on-demand")) {
        Text("When selected at launch").tag("on-demand"); Text("Always").tag("always"); Text("Disabled").tag("disabled")
      }
      TextField("Port", value: Binding(get: { fields["port"]?.number ?? 5432 }, set: { fields["port"] = .number($0) }), format: .number.precision(.fractionLength(0)))
      Text("Resource limits are selected in the profile or at launch.").font(.caption).foregroundStyle(.secondary)
    }
  }
}

struct SkillSourceEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  let repositories: [ConfigurationDocument]
  private var source: Binding<[String: ConfigurationJSON]> { Binding(get: { fields["source"]?.object ?? [:] }, set: { fields["source"] = .object($0) }) }
  private var mode: String { fields["source"]?["type"]?.string ?? "builtin" }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ConfigurationTextValue(title: "Skill name", fields: $fields, key: "name")
      Picker("Source", selection: Binding(get: { mode }, set: { value in
        var next: [String: ConfigurationJSON] = ["type": .string(value)]
        if value == "inline" { next["content"] = .string("") }
        if value == "local" { next["path"] = .string("") }
        if value == "github" { next["repositoryId"] = .string(""); next["path"] = .string("SKILL.md"); next["ref"] = .string("main") }
        source.wrappedValue = next
      })) {
        Text("Built in").tag("builtin"); Text("Write instructions").tag("inline"); Text("Daemon file").tag("local"); Text("GitHub repository").tag("github")
      }
      if mode == "inline" { ConfigurationTextValue(title: "Skill instructions", fields: source, key: "content", multiline: true) }
      if mode == "local" { ConfigurationTextValue(title: "Path on the daemon", fields: source, key: "path") }
      if mode == "github" {
        Picker("Repository", selection: Binding(get: { source.wrappedValue["repositoryId"]?.string ?? "" }, set: { source.wrappedValue["repositoryId"] = .string($0) })) { Text("Choose repository").tag(""); ForEach(repositories) { Text($0.name).tag($0.id) } }
        ConfigurationTextValue(title: "File path", fields: source, key: "path")
        ConfigurationTextValue(title: "Branch, tag or commit", fields: source, key: "ref")
      }
    }
  }
}

struct McpTransportEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private var transport: Binding<[String: ConfigurationJSON]> { Binding(get: { fields["transport"]?.object ?? [:] }, set: { fields["transport"] = .object($0) }) }
  private var mode: String { fields["transport"]?["type"]?.string ?? "http" }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ConfigurationTextValue(title: "Server name", fields: $fields, key: "name")
      Picker("Connection", selection: Binding(get: { mode }, set: { value in
        transport.wrappedValue = value == "http" ? ["type": .string("http"), "url": .string(""), "headers": .object([:])] : ["type": .string("stdio"), "command": .string(""), "args": .array([]), "env": .object([:])]
      })) { Text("HTTP").tag("http"); Text("Command in the pod").tag("stdio") }
      if mode == "http" {
        ConfigurationTextValue(title: "Server URL", fields: transport, key: "url")
      } else {
        ConfigurationTextValue(title: "Command", fields: transport, key: "command")
        ConfigurationStringListEditor(title: "Arguments", values: Binding(get: { transport.wrappedValue["args"]?.array ?? [] }, set: { transport.wrappedValue["args"] = .array($0) }))
      }
      DisclosureGroup("Credential references") { ConfigurationFieldsEditor(fields: transport, excluded: ["type", "url", "command", "args"]) }
      Text("HTTP credentials stay with the daemon. Command credentials must be enrolled for use inside the pod.").font(.caption).foregroundStyle(.secondary)
    }
  }
}
