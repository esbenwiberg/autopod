import AutopodClient
import SwiftUI

private func setupObject(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String) -> Binding<[String: ConfigurationJSON]> {
  Binding(get: { fields.wrappedValue[key]?.object ?? [:] }, set: { fields.wrappedValue[key] = .object($0) })
}
private func setupText(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String, fallback: String = "", optional: Bool = false) -> Binding<String> {
  Binding(get: { fields.wrappedValue[key]?.string ?? fallback }, set: {
    if optional && $0.isEmpty { fields.wrappedValue.removeValue(forKey: key) }
    else { fields.wrappedValue[key] = .string($0) }
  })
}

enum RepositorySetupSection: String, CaseIterable, Identifiable {
  case commands = "Commands", validation = "Validation", pages = "Smoke pages", variables = "Variables"
  case registries = "PR & registries", services = "Services", deployment = "Deployment", advanced = "Other fields"
  var id: String { rawValue }
}

struct RepositorySetupEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  @State private var section: RepositorySetupSection
  var feeds: [ConfigurationDocument]
  init(fields: Binding<[String: ConfigurationJSON]>, initialSection: RepositorySetupSection = .commands, feeds: [ConfigurationDocument] = []) {
    self._fields = fields; self._section = State(initialValue: initialSection); self.feeds = feeds
  }
  private var integrations: Binding<[String: ConfigurationJSON]> { setupObject($fields, "integrations") }
  private var deployment: Binding<[String: ConfigurationJSON]> {
    Binding(get: { fields["integrations"]?["deployment"]?.object ?? ["enabled": .bool(false), "source": .string("published-default"), "env": .object([:])] }, set: {
      integrations.wrappedValue["deployment"] = .object($0)
    })
  }
  var body: some View {
    HStack(alignment: .top, spacing: 18) {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(RepositorySetupSection.allCases) { item in
          Button { section = item } label: {
            Text(item.rawValue).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 10).padding(.vertical, 9)
              .background(section == item ? DesktopTheme.selection : Color.clear, in: RoundedRectangle(cornerRadius: 6))
              .foregroundStyle(section == item ? DesktopTheme.accent : .secondary)
          }.buttonStyle(.plain).accessibilityIdentifier("setup-section-\(item.id)")
        }
      }.frame(width: 138)
      VStack(alignment: .leading, spacing: 12) {
        switch section {
        case .commands: commands
        case .validation: validation
        case .pages: ConfigurationSmokePagesEditor(fields: $fields)
        case .variables: ConfigurationValueMapEditor(title: "Build environment", context: "Available to repository setup, build and validation commands.", id: "setup-env", values: setupObject($fields, "buildEnv"))
        case .registries: ConfigurationRegistryEditor(fields: integrations, feeds: feeds)
        case .services:
          ConfigurationObjectListEditor(title: "ADO and Azure log access", values: Binding(get: { integrations.wrappedValue["serviceAccess"]?.array ?? [] }, set: { integrations.wrappedValue["serviceAccess"] = .array($0) }), initial: {
            ["id": .string("access-\(UUID().uuidString.prefix(8).lowercased())"), "service": .string("ado"), "organization": .string(""), "project": .string(""), "repository": .string(""), "operations": .array([.string("code.file")])]
          }) { ServiceAccessRuleEditor(fields: $0) }
        case .deployment: RepositoryDeploymentEditor(fields: deployment)
        case .advanced:
          Text("Additional saved fields are retained. Complete JSON edits the entire repository payload.").font(.caption).foregroundStyle(.secondary)
          ConfigurationFieldsEditor(fields: $fields, excluded: ["id", "name", "defaultBranch", "buildWorkDir", "validationSetupCommand", "prepareCommand", "buildCommand", "testCommand", "lintCommand", "sastCommand", "startCommand", "healthPath", "healthTimeout", "hasWebUi", "buildTimeout", "testTimeout", "lintTimeout", "sastTimeout", "smokePages", "buildEnv", "integrations"])
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  private var commands: some View {
    ConfigurationSection(title: "Commands & paths", subtitle: "Commands run inside this repository's workspace. Empty optional commands are disabled.") {
      ConfigurationTextValue(title: "Setup name", fields: $fields, key: "name")
      VStack(alignment: .leading, spacing: 4) {
        Text("Default branch").font(.caption).foregroundStyle(.secondary)
        TextField("Default branch", text: setupText($fields, "defaultBranch", fallback: "main"))
      }
      ConfigurationTextValue(title: "Working directory", fields: $fields, key: "buildWorkDir", optional: true)
      ForEach([("validationSetupCommand", "Setup command"), ("prepareCommand", "Prepare command"), ("buildCommand", "Build command"), ("testCommand", "Test command"), ("lintCommand", "Lint command"), ("sastCommand", "SAST command"), ("startCommand", "Start command")], id: \.0) { key, title in
        ConfigurationTextValue(title: title, fields: $fields, key: key, optional: true)
      }
    }
  }
  private var validation: some View {
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationSection(title: "Health & browser checks", subtitle: "Workflow presets choose which validation phases run. This setup supplies their commands and web targets.") {
        Toggle("Project has a web UI", isOn: Binding(get: { fields["hasWebUi"]?.bool ?? true }, set: { fields["hasWebUi"] = .bool($0) }))
          .accessibilityIdentifier("setup-web-ui")
        LabeledContent("Health path") {
          TextField("Health path", text: Binding(get: {
            fields["healthPath"] == nil ? "/" : fields["healthPath"]?.string ?? ""
          }, set: { fields["healthPath"] = $0.isEmpty ? .null : .string($0) }))
        }
        Text("Use an absolute URL path such as /health. Clear it to store no health path.").font(.caption).foregroundStyle(.secondary)
      }
      ConfigurationSection(title: "Timeouts", subtitle: "Seconds per phase, from 1 to 86400. Reset uses the daemon default.") {
        ForEach([("buildTimeout", "Build", 300), ("testTimeout", "Tests", 600), ("lintTimeout", "Lint", 120), ("sastTimeout", "SAST", 300), ("healthTimeout", "Health", 120)], id: \.0) { key, title, fallback in
          ConfigurationSetupTimeout(fields: $fields, key: key, title: title, fallback: fallback)
        }
      }
    }
  }
}

private struct ConfigurationSetupTimeout: View {
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  let title: String
  let fallback: Int
  private var formatter: NumberFormatter {
    let f = NumberFormatter(); f.numberStyle = .decimal; f.usesGroupingSeparator = false; f.allowsFloats = false
    f.minimum = 1; f.maximum = 86400; return f
  }
  var body: some View {
    HStack {
      Text(title).frame(width: 65, alignment: .leading)
      TextField("\(title) timeout", value: Binding(get: { Int(fields[key]?.number ?? Double(fallback)) }, set: { fields[key] = .number(Double($0)) }), formatter: formatter)
        .frame(width: 100).accessibilityIdentifier("setup-timeout-\(key)")
      Text("seconds").font(.caption).foregroundStyle(.secondary)
      Spacer()
      Button("Reset") { fields.removeValue(forKey: key) }.disabled(fields[key] == nil)
        .accessibilityIdentifier("setup-timeout-reset-\(key)")
    }
  }
}

struct ConfigurationSmokePagesEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private var pages: [ConfigurationJSON] { fields["smokePages"]?.array ?? [] }
  private func page(_ index: Int) -> Binding<[String: ConfigurationJSON]> {
    Binding(get: { pages.indices.contains(index) ? pages[index].object ?? [:] : [:] }, set: {
      var next = pages; guard next.indices.contains(index) else { return }; next[index] = .object($0); fields["smokePages"] = .array(next)
    })
  }
  var body: some View {
    ConfigurationSection(title: "Smoke pages", subtitle: "Pages visited by the Pages validation phase. Paths start with /; selectors use CSS.") {
      if pages.isEmpty { Text("No pages configured. Add a page and its assertions.").foregroundStyle(.secondary) }
      ForEach(pages.indices, id: \.self) { index in
        let current = page(index)
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("Page \(index + 1)").font(.headline)
            Spacer()
            Button("Remove page", systemImage: "minus.circle", role: .destructive) {
              var next = pages; next.remove(at: index); fields["smokePages"] = .array(next)
            }.labelStyle(.iconOnly).accessibilityIdentifier("setup-page-remove-\(index)")
          }
          TextField("Page path", text: setupText(current, "path"))
            .accessibilityIdentifier("setup-page-path-\(index)")
          ConfigurationSmokeAssertionsEditor(fields: current, pageIndex: index)
        }
        Divider()
      }
      Button("Add page", systemImage: "plus") { fields["smokePages"] = .array(pages + [.object(["path": .string("/"), "assertions": .array([])])]) }
        .accessibilityIdentifier("setup-page-add")
    }
  }
}

private struct ConfigurationSmokeAssertionsEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  let pageIndex: Int
  private var assertions: [ConfigurationJSON] { fields["assertions"]?.array ?? [] }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(assertions.indices, id: \.self) { index in
        let row = Binding<[String: ConfigurationJSON]>(get: { assertions.indices.contains(index) ? assertions[index].object ?? [:] : [:] }, set: {
          var next = assertions; guard next.indices.contains(index) else { return }; next[index] = .object($0); fields["assertions"] = .array(next)
        })
        HStack {
          TextField("CSS selector", text: setupText(row, "selector"))
            .accessibilityIdentifier("setup-assertion-selector-\(pageIndex)-\(index)")
          Picker("Assertion", selection: setupText(row, "type", fallback: "exists")) {
            Text("Exists").tag("exists"); Text("Visible").tag("visible"); Text("Contains text").tag("text_contains"); Text("Count").tag("count")
          }.frame(maxWidth: 170).accessibilityIdentifier("setup-assertion-type-\(pageIndex)-\(index)")
          Button("Remove assertion", systemImage: "minus.circle", role: .destructive) {
            var next = assertions; next.remove(at: index); fields["assertions"] = .array(next)
          }.labelStyle(.iconOnly).accessibilityIdentifier("setup-assertion-remove-\(pageIndex)-\(index)")
        }
        if ["text_contains", "count"].contains(row.wrappedValue["type"]?.string ?? "exists") || row.wrappedValue["value"] != nil {
          TextField("Expected value", text: setupText(row, "value", optional: true))
            .accessibilityIdentifier("setup-assertion-value-\(pageIndex)-\(index)")
        }
      }
      Button("Add assertion", systemImage: "plus") { fields["assertions"] = .array(assertions + [.object(["selector": .string(""), "type": .string("exists")])]) }
        .accessibilityIdentifier("setup-assertion-add-\(pageIndex)")
    }
  }
}

struct ConfigurationRegistryEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  var feeds: [ConfigurationDocument] = []
  private var registries: [ConfigurationJSON] { fields["privateRegistries"]?.array ?? [] }
  var body: some View {
    ConfigurationSection(title: "PR provider & registries", subtitle: "Repository-specific delivery and package feeds. Credentials stay enrolled with the daemon.") {
      Picker("Pull request provider", selection: setupText($fields, "prProvider", fallback: "github")) {
        Text("GitHub").tag("github"); Text("Azure DevOps").tag("ado")
      }.accessibilityIdentifier("setup-pr-provider")
      Text("Package feeds").font(.headline)
      Text("Create shared feeds in Building blocks → Package feeds. Selecting a feed applies to future launches.").font(.caption).foregroundStyle(.secondary)
      ForEach(feeds) { feed in
        Toggle(feed.name, isOn: Binding(get: { fields["packageFeedIds"]?.array?.contains(.string(feed.id)) ?? false }, set: { enabled in
          var ids = fields["packageFeedIds"]?.array ?? []
          ids.removeAll { $0 == .string(feed.id) }
          if enabled { ids.append(.string(feed.id)) }
          fields["packageFeedIds"] = .array(ids)
        })).accessibilityIdentifier("setup-feed-\(feed.id)")
      }
      ForEach((fields["packageFeedIds"]?.array?.compactMap(\.string) ?? []).filter { id in !feeds.contains { $0.id == id } }, id: \.self) { id in
        HStack {
          Text("Unavailable feed: \(id)").foregroundStyle(.orange)
          Button("Remove selection") { fields["packageFeedIds"] = .array((fields["packageFeedIds"]?.array ?? []).filter { $0 != .string(id) }) }
        }
      }
      Divider()
      Text("Legacy inline registries").font(.headline)
      Text("Retained for compatibility. When adopting a shared feed, remove its duplicate inline entry before saving.").font(.caption).foregroundStyle(.secondary)
      if registries.isEmpty { Text("No inline registries configured.").foregroundStyle(.secondary) }
      ForEach(registries.indices, id: \.self) { index in
        let row = Binding<[String: ConfigurationJSON]>(get: { registries.indices.contains(index) ? registries[index].object ?? [:] : [:] }, set: {
          var next = registries; guard next.indices.contains(index) else { return }; next[index] = .object($0); fields["privateRegistries"] = .array(next)
        })
        Divider()
        HStack {
          Text("Registry \(index + 1)").font(.headline)
          Spacer()
          Button("Remove registry", systemImage: "minus.circle", role: .destructive) {
            var next = registries; next.remove(at: index); fields["privateRegistries"] = .array(next)
          }.labelStyle(.iconOnly).accessibilityIdentifier("setup-registry-remove-\(index)")
        }
        Picker("Package type", selection: setupText(row, "type", fallback: "npm")) { Text("npm").tag("npm"); Text("NuGet").tag("nuget") }
          .accessibilityIdentifier("setup-registry-type-\(index)")
        LabeledContent("Registry URL") {
          TextField("Registry HTTPS URL", text: setupText(row, "url"))
            .accessibilityIdentifier("setup-registry-url-\(index)")
        }
        LabeledContent("npm scope") {
          TextField("npm scope (optional)", text: setupText(row, "scope", optional: true))
            .accessibilityIdentifier("setup-registry-scope-\(index)")
        }
        LabeledContent("Credential ID") {
        TextField("Registry credential ID", text: Binding(get: { row.wrappedValue["credential"]?["secretId"]?.string ?? "" }, set: {
          if $0.isEmpty { row.wrappedValue["credential"] = .null }
          else { var reference = row.wrappedValue["credential"]?.object ?? [:]; reference["secretId"] = .string($0); row.wrappedValue["credential"] = .object(reference) }
        })).accessibilityIdentifier("setup-registry-credential-\(index)")
        }
        LabeledContent("Expiry") {
        TextField("Expiry YYYY-MM-DD (optional)", text: Binding(get: { row.wrappedValue["expiresAt"]?.string ?? "" }, set: { row.wrappedValue["expiresAt"] = $0.isEmpty ? .null : .string($0) }))
          .accessibilityIdentifier("setup-registry-expiry-\(index)")
        }
        Text("Use an enrolled credential ID. A saved ID is retained even when unavailable; the daemon checks permission and expiry. URLs cannot contain credentials, queries or fragments.").font(.caption).foregroundStyle(.secondary)
      }
      Button("Add registry", systemImage: "plus") { fields["privateRegistries"] = .array(registries + [.object(["type": .string("npm"), "url": .string(""), "credential": .null, "expiresAt": .null])]) }
        .accessibilityIdentifier("setup-registry-add")
    }
  }
}
