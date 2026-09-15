import AutopodClient
import SwiftUI

struct RepositoryMultiSelect: View {
  let repositories: [ConfigurationJSON]
  @Binding var selectedIDs: [String]
  let loading: Bool
  let refresh: () -> Void
  var singleSelection = false
  @State private var expanded = false
  @State private var search = ""
  @State private var selectedOnly = false
  @FocusState private var searchFocused: Bool

  private var choices: [(id: String, name: String)] {
    let known = repositories.compactMap { repo -> (id: String, name: String)? in
      guard let id = repo["id"]?.string, !id.isEmpty else { return nil }
      return (id, "\(repo["ownerLogin"]?.string ?? "")/\(repo["name"]?.string ?? id)")
    }
    let knownIDs = Set(known.map(\.id))
    return (known + selectedIDs.filter { !knownIDs.contains($0) }.map { ($0, "Unavailable repository (\($0))") })
      .filter { (!selectedOnly || selectedIDs.contains($0.id)) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  var body: some View {
    Button {
      search = ""; selectedOnly = false; expanded = true
    } label: {
      HStack {
        Image(systemName: "folder")
        Text(singleSelection ? (choices.first(where: { selectedIDs.contains($0.id) })?.name ?? "Choose repository…") : selectedIDs.isEmpty ? "Choose repositories…" : "\(selectedIDs.count) repositories selected")
          .lineLimit(1).truncationMode(.middle)
        Spacer()
        Image(systemName: "chevron.down").foregroundStyle(.secondary)
      }.padding(8).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(.background, in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
    .popover(isPresented: $expanded, arrowEdge: .bottom) {
      VStack(alignment: .leading, spacing: 12) {
        TextField("Search repositories…", text: $search).textFieldStyle(.roundedBorder).focused($searchFocused)
        HStack {
          Picker("Show", selection: $selectedOnly) {
            Text("All repositories").tag(false)
            Text("Selected (\(selectedIDs.count))").tag(true)
          }.pickerStyle(.segmented).labelsHidden()
          Button(action: refresh) { Image(systemName: "arrow.clockwise") }
            .help("Refresh repositories").disabled(loading)
        }
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 2) {
            if loading { ProgressView("Loading repositories…") }
            if choices.isEmpty && !loading {
              Text(search.isEmpty ? "No repositories available in this view." : "No repositories match your search.")
                .foregroundStyle(.secondary).padding(8)
            }
            ForEach(choices, id: \.id) { choice in
              Button {
                if singleSelection { selectedIDs = [choice.id]; expanded = false }
                else if selectedIDs.contains(choice.id) { selectedIDs.removeAll { $0 == choice.id } }
                else { selectedIDs.append(choice.id) }
              } label: {
                HStack {
                  Text(choice.name).lineLimit(1).truncationMode(.middle)
                  Spacer()
                  Image(systemName: selectedIDs.contains(choice.id) ? "checkmark" : "plus")
                    .foregroundStyle(selectedIDs.contains(choice.id) ? Color.accentColor : Color.secondary)
                }.padding(8).contentShape(Rectangle())
              }.buttonStyle(.plain)
                .help(choice.name)
                .accessibilityLabel(choice.name)
                .accessibilityValue(selectedIDs.contains(choice.id) ? "Selected" : "Not selected")
            }
          }
        }.frame(height: 260)
        Divider()
        HStack {
          Text("\(selectedIDs.count) selected").font(.caption).foregroundStyle(.secondary)
          Spacer()
          Button("Done") { expanded = false }.keyboardShortcut(.defaultAction)
        }
      }.padding(16).frame(width: 420)
        .onAppear { searchFocused = true }
        .onExitCommand { expanded = false }
    }
  }
}

struct GitHubAccessRuleEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  let actions: LaunchConfigurationActions
  @State private var repositories: [ConfigurationJSON] = []
  @State private var workflows: [String: [ConfigurationJSON]] = [:]
  @State private var error: String?
  @State private var loading = false
  private var rules: [ConfigurationJSON] { payload["rules"]?.array ?? [] }
  private let permissions: [(String, [(String, String)])] = [
    ("Read", [("code.read", "Code"), ("issues.read", "Issues"), ("prs.read", "Pull requests, diffs and reviews"), ("actions.read", "Actions runs, jobs, logs and artifacts")]),
    ("Issue changes", [("issues.create", "Create issues"), ("issues.edit", "Edit issues"), ("issues.close", "Close issues"), ("issues.labels", "Change issue labels"), ("issues.comment", "Comment on issues")]),
    ("PR comments", [("prs.comment", "Comment on pull requests")]),
    ("Actions", [("workflows.dispatch", "Dispatch workflows"), ("runs.rerun", "Rerun workflow runs"), ("runs.cancel", "Cancel workflow runs")]),
  ]
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Each rule combines repository scope and operations. Workflow and branch restrictions apply to Actions writes.").font(.callout).foregroundStyle(.secondary)
      Text("Only the daemon can push, publish branches, create or edit PRs, and merge.").font(.callout)
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(Array(rules.enumerated()), id: \.offset) { index, rule in
        GroupBox {
          VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Access rule \(index + 1)").font(.headline); Spacer(); Button("Remove") { var updated = rules; updated.remove(at: index); payload["rules"] = .array(updated) } }
            scopeEditor(index, rule)
            ForEach(permissions, id: \.0) { group, items in
              ConfigurationSection(title: group) {
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 10) {
                  ForEach(items, id: \.0) { operation, label in
                    Toggle(label, isOn: Binding(get: { rule["operations"]?.array?.contains(.string(operation)) ?? false }, set: { enabled in
                      var operations = rules[index]["operations"]?.array ?? []; operations.removeAll { $0 == .string(operation) }; if enabled { operations.append(.string(operation)) }; set(index, "operations", .array(operations))
                    }))
                  }
                }
              }
            }
            if rule["operations"]?.array?.contains(where: { ["workflows.dispatch", "runs.rerun", "runs.cancel"].contains($0.string ?? "") }) == true {
              workflowEditor(index, rule)
              Picker("Allowed branches", selection: Binding(get: { rule["branches"]?["mode"]?.string ?? "selected" }, set: { set(index, "branches", .object($0 == "all" ? ["mode": .string("all")] : ["mode": .string("selected"), "names": .array([])])) })) {
                Text("Selected branches").tag("selected"); Text("All branches").tag("all")
              }
              if rule["branches"]?["mode"]?.string != "all" {
                TextField("Exact branch names, separated by commas", text: Binding(get: { rule["branches"]?["names"]?.array?.compactMap(\.string).joined(separator: ", ") ?? "" }, set: { names in
                  set(index, "branches", .object(["mode": .string("selected"), "names": .array(names.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) })]))
                }))
              }
            }
          }.padding(8)
        }
      }
      Button("Add access rule") {
        payload["rules"] = .array(rules + [.object(["id": .string(UUID().uuidString), "repositories": .object(["mode": .string("current")]), "operations": .array(["code.read", "issues.read", "prs.read", "actions.read"].map(ConfigurationJSON.string)), "workflows": .object(["mode": .string("selected"), "files": .array([])]), "branches": .object(["mode": .string("selected"), "names": .array([])])])])
      }
    }.task { await loadRepositories() }
  }
  @ViewBuilder private func scopeEditor(_ index: Int, _ rule: ConfigurationJSON) -> some View {
    let scope = rule["repositories"] ?? .object(["mode": .string("current")])
    Picker("Repositories", selection: Binding(get: { scope["mode"]?.string ?? "current" }, set: { mode in
      var value: [String: ConfigurationJSON] = ["mode": .string(mode)]
      if mode == "selected" { value["repositoryIds"] = .array([]) }
      if mode == "owner" { value["ownerId"] = .string(""); value["ownerLogin"] = .string(""); value["selection"] = .object(["mode": .string("all")]) }
      set(index, "repositories", .object(value))
    })) { Text("Current repository").tag("current"); Text("Selected repositories").tag("selected"); Text("Owner or organization").tag("owner") }
    if scope["mode"]?.string == "owner" {
      let owners = Dictionary(grouping: repositories, by: { $0["ownerId"]?.string ?? "" }).compactMap { $0.value.first }.sorted { ($0["ownerLogin"]?.string ?? "") < ($1["ownerLogin"]?.string ?? "") }
      Picker("Owner", selection: Binding(get: { scope["ownerId"]?.string ?? "" }, set: { id in
        guard let owner = owners.first(where: { $0["ownerId"]?.string == id }) else { return }
        var value = scope.object ?? [:]; value["ownerId"] = .string(id); value["ownerLogin"] = owner["ownerLogin"]; set(index, "repositories", .object(value))
      })) { Text("Choose owner").tag(""); ForEach(Array(owners.enumerated()), id: \.offset) { _, owner in Text(owner["ownerLogin"]?.string ?? "Owner").tag(owner["ownerId"]?.string ?? "") } }
      Toggle("All accessible repositories under this owner", isOn: Binding(get: { scope["selection"]?["mode"]?.string == "all" }, set: { all in
        var value = scope.object ?? [:]; value["selection"] = .object(all ? ["mode": .string("all")] : ["mode": .string("selected"), "repositoryIds": .array([])]); set(index, "repositories", .object(value))
      }))
      Text("The repository list is frozen at launch. New repositories are included on future launches.").font(.caption).foregroundStyle(.secondary)
    }
    if scope["mode"]?.string == "selected" || scope["selection"]?["mode"]?.string == "selected" {
      let selectedIDs = (scope["mode"]?.string == "owner" ? scope["selection"]?["repositoryIds"] : scope["repositoryIds"])?.array?.compactMap(\.string) ?? []
      RepositoryMultiSelect(repositories: repositories.filter {
        scope["mode"]?.string != "owner" || $0["ownerId"] == scope["ownerId"]
      }, selectedIDs: Binding(get: { selectedIDs }, set: { ids in
        var value = scope.object ?? [:]
        if scope["mode"]?.string == "owner" {
          var selection = scope["selection"]?.object ?? [:]
          selection["repositoryIds"] = .array(ids.map(ConfigurationJSON.string))
          value["selection"] = .object(selection)
        } else { value["repositoryIds"] = .array(ids.map(ConfigurationJSON.string)) }
        set(index, "repositories", .object(value))
      }), loading: loading, refresh: { Task { await loadRepositories() } })
    }
  }
  @ViewBuilder private func workflowEditor(_ index: Int, _ rule: ConfigurationJSON) -> some View {
    Picker("Allowed workflows", selection: Binding(get: { rule["workflows"]?["mode"]?.string ?? "selected" }, set: { set(index, "workflows", .object($0 == "all" ? ["mode": .string("all")] : ["mode": .string("selected"), "files": .array([])])) })) {
      Text("Selected workflows").tag("selected"); Text("All workflows").tag("all")
    }
    if rule["workflows"]?["mode"]?.string == "all" { Text("Includes workflows added later in the matching repositories. Branch restrictions still apply.").font(.caption).foregroundStyle(.secondary) }
    else {
      Button("Load workflow choices") { Task { await loadWorkflows(rule) } }.disabled(loading)
      ForEach(Array((workflows[rule["id"]?.string ?? ""] ?? []).enumerated()), id: \.offset) { _, workflow in
        let file: ConfigurationJSON = .object(["repositoryId": workflow["repositoryId"] ?? .string(""), "path": workflow["path"] ?? .string(""), "workflowId": workflow["id"] ?? .string("")])
        let repo = repositories.first { $0["id"] == workflow["repositoryId"] }
        Toggle("\(repo.map(repoName) ?? "Repository") · \(workflow["name"]?.string ?? workflow["path"]?.string ?? "Workflow")", isOn: Binding(get: { rule["workflows"]?["files"]?.array?.contains(file) ?? false }, set: { enabled in
          var files = rules[index]["workflows"]?["files"]?.array ?? []; files.removeAll { $0 == file }; if enabled { files.append(file) }; set(index, "workflows", .object(["mode": .string("selected"), "files": .array(files)]))
        }))
      }
    }
  }
  private func repoName(_ repo: ConfigurationJSON) -> String { "\(repo["ownerLogin"]?.string ?? "")/\(repo["name"]?.string ?? "")" }
  private func set(_ index: Int, _ key: String, _ value: ConfigurationJSON) { guard rules.indices.contains(index) else { return }; var updated = rules; var rule = updated[index].object ?? [:]; rule[key] = value; updated[index] = .object(rule); payload["rules"] = .array(updated) }
  private func loadRepositories() async { loading = true; defer { loading = false }; do { repositories = try await actions.discoverGitHubRepositories(); error = nil } catch { self.error = error.localizedDescription } }
  private func loadWorkflows(_ rule: ConfigurationJSON) async {
    loading = true; defer { loading = false }; let ruleId = rule["id"]?.string ?? ""; workflows[ruleId] = []
    do {
      let scope = rule["repositories"]
      let ids: [String]
      if scope?["mode"]?.string == "selected" { ids = scope?["repositoryIds"]?.array?.compactMap(\.string) ?? [] }
      else if scope?["mode"]?.string == "owner" && scope?["selection"]?["mode"]?.string == "selected" { ids = scope?["selection"]?["repositoryIds"]?.array?.compactMap(\.string) ?? [] }
      else if scope?["mode"]?.string == "owner" { ids = repositories.filter { $0["ownerId"] == scope?["ownerId"] }.compactMap { $0["id"]?.string } }
      else { throw LaunchJSONError.invalid("Select explicit repositories to choose their workflows, or choose all workflows for the current repository.") }
      var loaded: [ConfigurationJSON] = []; for id in ids { loaded += try await actions.discoverGitHubWorkflows(id) }; workflows[ruleId] = loaded; error = nil
    } catch { self.error = error.localizedDescription }
  }
}
