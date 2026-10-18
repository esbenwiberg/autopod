import AutopodClient
import SwiftUI

/// Shared by single-pod and series composers. Typed edits retain every unrelated request field.
struct LaunchConfigurationEditor: View {
  @Binding var request: ComposableLaunchRequest
  let actions: LaunchConfigurationActions
  @Binding var jsonDirty: Bool
  var selectionOnly = false
  @State private var section: LaunchConfigurationSection?
  @Binding var advanced: String
  @State private var error: String?
  @State private var showPim = false
  private var repository: ConfigurationDocument? { actions.list(.repository).first { $0.id == request.repositoryId } }
  private var profileID: String? { request.profileId ?? repository?.payload["usualProfileId"]?.string }
  private var profile: ConfigurationDocument? { actions.list(.profile).first { $0.id == profileID } }
  private var environment: ConfigurationDocument? { actions.list(.environment).first { $0.id == (request.selections?.environmentId ?? profile?.payload["environmentId"]?.string) } }
  private var sidecars: [ConfigurationJSON] { request.overrides?.environment?["sidecars"]?.array ?? environment?.payload["sidecars"]?.array ?? [] }
  private var selectedSidecars: [String] {
    if let selected = request.requiredSidecarIds { return selected }
    guard environment?.id == profile?.payload["environmentId"]?.string else { return [] }
    return profile?.payload["requiredSidecarIds"]?.array?.compactMap(\.string) ?? []
  }
  private var effectivePim: [[String: ConfigurationJSON]] { request.overrides?.pim ?? profile?.payload["pim"]?.array?.compactMap(\.object) ?? [] }
  private var launchAvailable: Bool { actions.capabilities["launchAvailable"]?.bool ?? false }
  private var executionTarget: String { request.overrides?.execution?["target"]?.string ?? profile?.payload["execution"]?["target"]?.string ?? "local" }
  private var backend: ConfigurationJSON? { actions.capabilities["execution"]?.array?.first { $0["target"]?.string == executionTarget } }
  private var nativeGoalAvailable: Bool {
    let ai = actions.list(.ai).first { $0.id == (request.selections?.aiId ?? profile?.payload["aiId"]?.string) }
    let main = request.overrides?.ai?["main"] ?? ai?.payload["main"]
    return actions.capabilities["nativeGoals"]?.array?.contains { $0["available"]?.bool == true && $0["runtime"]?.string == main?["runtime"]?.string && $0["accountId"]?.string == main?["providerAccountId"]?.string && $0["backend"]?.string == executionTarget } ?? false
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      if let section {
        Button("← All configuration") { self.section = nil }.buttonStyle(.plain).foregroundStyle(DesktopTheme.accent)
        Text(section.rawValue).font(.title2.weight(.semibold))
        detail(section)
      } else {
        Text("Keep the defaults. Change what matters.").font(.title2.weight(.semibold))
        Text("Inspect inherited values, choose a preset or edit this launch. Reusable configuration stays unchanged.")
          .font(.callout).foregroundStyle(.secondary)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 14)], spacing: 14) {
          ForEach(LaunchConfigurationSection.allCases) { item in
            Button { section = item } label: {
              VStack(alignment: .leading, spacing: 14) {
                HStack { Text(item.rawValue).font(.subheadline.weight(.semibold)); Spacer(); Image(systemName: "arrow.up.right") }
                Text(context.value(item)).font(.headline).lineLimit(2).frame(minHeight: 36, alignment: .topLeading)
                Text(item.subtitle).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(context.origin(item)).font(.caption2).foregroundStyle(DesktopTheme.accent)
              }.padding(18).frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
                .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(DesktopTheme.line))
                .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("launch-config-\(item.id)")
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
    }
    .onAppear { if advanced.isEmpty { updateAdvanced() } }
    .onChange(of: request) { _, _ in if !jsonDirty { updateAdvanced() } }
    .onChange(of: section) { _, section in if section == .advanced && !jsonDirty { updateAdvanced() } }
    .sheet(isPresented: $showPim) {
      PimSelectionSheet(selected: effectivePim, cached: actions.cachedPim(), discover: actions.discoverPim) { selections in
        if request.overrides == nil { request.overrides = LaunchOverrides() }
        request.overrides?.pim = selections
      }
    }
  }
  private var context: LaunchComposerContext { .init(request: request, actions: actions) }
  @ViewBuilder private func detail(_ section: LaunchConfigurationSection) -> some View {
    switch section {
    case .environment: presetRow(.environment, key: "environmentId", selected: request.selections?.environmentId, edited: request.overrides?.environment != nil)
    case .ai: presetRow(.ai, key: "aiId", selected: request.selections?.aiId, edited: request.overrides?.ai != nil)
    case .workflow: presetRow(.workflow, key: "workflowId", selected: request.selections?.workflowId, edited: request.overrides?.workflow != nil)
    case .github: githubRow
    case .tools: toolPacksRow
    case .execution: executionRow
    case .pim:
      ForEach(Array(effectivePim.enumerated()), id: \.offset) { _, value in
        Text("\(value["displayName"]?.string ?? "Role") · \(value["scope"]?.string ?? "")").font(.callout)
      }
      HStack {
        Button("Choose eligible access…") { showPim = true }
        Button("Use profile default") { request.overrides?.pim = nil }
        Button("Clear selection") { if request.overrides == nil { request.overrides = LaunchOverrides() }; request.overrides?.pim = [] }
      }
      Text("Selections use the same account. Choosing access here does not activate it.").font(.caption).foregroundStyle(.secondary)
    case .references: references
    case .advanced:
      Text(selectionOnly ? "Series supplies task, work and request identity. All shared configuration fields remain editable." : "Complete launch request, including structured work, source and category overrides.").font(.callout).foregroundStyle(.secondary)
      TextEditor(text: Binding(get: { advanced }, set: { advanced = $0; jsonDirty = true }))
        .font(.system(.callout, design: .monospaced)).frame(minHeight: 300).scrollContentBackground(.hidden)
        .padding(10).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("launch-advanced-json")
      if jsonDirty { Text("Unapplied JSON edits. Apply or reload before previewing or launching.").foregroundStyle(.orange).font(.caption) }
      HStack {
        Button("Apply JSON") {
          do { request = try LaunchComposerJSON.decode(advanced, selectionOnly: selectionOnly, task: request.task); jsonDirty = false; error = nil }
          catch { self.error = error.localizedDescription }
        }
        Button("Reload current values") { updateAdvanced(); jsonDirty = false; error = nil }
      }
    }
    if ![.advanced, .pim, .references].contains(section) {
      DisclosureGroup("Inspect complete values") {
        Text(context.details(section).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
      }
      Text("All category overrides remain editable in Full launch JSON. The daemon preview determines the effective settings.")
        .font(.caption).foregroundStyle(.secondary)
    }
  }
  private var references: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Read-only repositories to consult alongside the working tree.").font(.callout).foregroundStyle(.secondary)
      ForEach(Array((request.referenceRepositories ?? []).enumerated()), id: \.offset) { index, ref in
        VStack(alignment: .leading, spacing: 10) {
          Picker("Repository", selection: Binding(get: { request.referenceRepositories?[index].repositoryId ?? ref.repositoryId }, set: { request.referenceRepositories?[index].repositoryId = $0 })) {
            if !actions.list(.repository).contains(where: { $0.id == ref.repositoryId }) { Text(ref.repositoryId.isEmpty ? "Select repository" : ref.repositoryId).tag(ref.repositoryId) }
            ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
          }
          TextField("Ref", text: Binding(get: { request.referenceRepositories?[index].ref ?? ref.ref }, set: { request.referenceRepositories?[index].ref = $0 }))
            .textFieldStyle(.roundedBorder)
          HStack { Text("Read-only").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Remove") { request.referenceRepositories?.remove(at: index) } }
        }.padding(16).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
      }
      Button("Add reference repository") {
        if request.referenceRepositories == nil { request.referenceRepositories = [] }
        request.referenceRepositories?.append(.init(repositoryId: actions.list(.repository).first?.id ?? "", ref: "main"))
      }
    }
  }
  private func updateAdvanced() { advanced = LaunchComposerJSON.value(request, selectionOnly: selectionOnly).formatted() }
  private func presetRow(_ kind: ConfigurationKind, key: String, selected: String?, edited: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Picker("Preset", selection: Binding(get: { selected ?? "" }, set: { request.select(kind, id: $0.isEmpty ? nil : $0) })) {
          let defaultName = actions.list(kind).first { $0.id == profile?.payload[key]?.string }?.name ?? "not selected"
          Text("Profile default · \(defaultName)").tag("")
          ForEach(actions.list(kind)) { Text($0.name).tag($0.id) }
        }
        if edited { Button("Reset edits") { request.overrides?.reset(kind) } }
      }.padding(.top, 8)
    }
  }
  private var githubRow: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading) {
        Picker("Access preset", selection: Binding(get: {
          switch request.selections?.githubAccess ?? .profileDefault { case .profileDefault: ""; case .noAccess: "__none"; case .preset(let id): id }
        }, set: { id in
          if request.selections == nil { request.selections = LaunchSelections() }
          request.selections?.githubAccess = id.isEmpty ? .profileDefault : id == "__none" ? .noAccess : .preset(id)
          request.overrides?.githubAccess = nil
        })) {
          Text("Profile default").tag(""); Text("No agent GitHub access").tag("__none")
          ForEach(actions.list(.githubAccess)) { Text($0.name).tag($0.id) }
        }
        Text("Push, PR creation and editing, and merge are performed by the daemon after its delivery checks.").font(.caption).foregroundStyle(.secondary)
      }.padding(.top, 8)
    }
  }
  private var toolPacksRow: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading) {
        Toggle("Use profile tool packs", isOn: Binding(get: { request.selections?.toolPackIds == nil }, set: { useDefault in
          if request.selections == nil { request.selections = LaunchSelections() }
          request.selections?.toolPackIds = useDefault ? nil : selectedToolPacks
          request.overrides?.toolPacks = nil
        }))
        ForEach(actions.list(.toolPack)) { pack in
          Toggle(pack.name, isOn: Binding(get: { selectedToolPacks.contains(pack.id) }, set: { enabled in
            var ids = selectedToolPacks; ids.removeAll { $0 == pack.id }; if enabled { ids.append(pack.id) }
            if request.selections == nil { request.selections = LaunchSelections() }; request.selections?.toolPackIds = ids; request.overrides?.toolPacks = nil
          })).disabled(request.selections?.toolPackIds == nil)
        }
        Button("Use profile defaults") { request.selections?.toolPackIds = nil; request.overrides?.toolPacks = nil }
      }.padding(.top, 8)
    }
  }
  private var selectedToolPacks: [String] { request.selections?.toolPackIds ?? profile?.payload["toolPackIds"]?.array?.compactMap(\.string) ?? [] }
  private var executionRow: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading) {
        Picker("Run in", selection: Binding(get: { request.overrides?.execution?["target"]?.string ?? "" }, set: { value in
          if request.overrides == nil { request.overrides = LaunchOverrides() }
          if value.isEmpty { request.overrides?.execution = nil }
          else {
            var execution = request.overrides?.execution ?? [:]; execution["target"] = .string(value)
            if value != executionTarget { execution["main"] = .object(["memoryGb": .null, "cpus": .null, "storageGb": .null]); execution["sidecars"] = .object([:]) }
            request.overrides?.execution = execution
          }
        })) {
          Text("Profile default").tag("")
          ForEach(["local", "sandbox"], id: \.self) { target in
            Text(target == "local" ? "Docker" : "Hosted sandbox").tag(target).disabled(!(actions.capabilities["execution"]?.array?.first { $0["target"]?.string == target }?["available"]?.bool ?? false))
          }
        }
        if backend?["available"]?.bool != true { Text(backend?["unavailableReason"]?.string ?? "Backend capabilities are unavailable.").font(.caption).foregroundStyle(.orange) }
        if let tiers = backend?["memoryTiersGb"]?.array?.compactMap(\.number) {
          Picker("Memory", selection: allocationChoice("memoryGb")) {
            Text("Profile default").tag("profile")
            Text("Backend default").tag("backend")
            ForEach(tiers, id: \.self) { value in Text("\(value.formatted()) GB").tag(String(value)) }
            if let value = request.overrides?.execution?["main"]?["memoryGb"]?.number, !tiers.contains(value) { Text("\(value.formatted()) GB · unavailable").tag(String(value)) }
          }
        } else { HStack {
          Text("Memory (GB)")
          TextField("Backend default", text: Binding(get: { request.overrides?.execution?["main"]?["memoryGb"]?.number.map { String($0) } ?? "" }, set: { value in
            if request.overrides == nil { request.overrides = LaunchOverrides() }
            var execution = request.overrides?.execution ?? [:]; var main = execution["main"]?.object ?? [:]
            if value.isEmpty { main["memoryGb"] = .null } else if let amount = Double(value), amount > 0 { main["memoryGb"] = .number(amount) } else { return }
            execution["main"] = .object(main); request.overrides?.execution = execution
          })).frame(width: 130)
        } }
        HStack { Text("Storage (GB)"); TextField("Backend default", text: allocationText("storageGb")).frame(width: 130) }
        if let maxCpus = backend?["maxCpus"]?.number {
          HStack {
            Text("CPUs")
            TextField("Backend default", text: allocationText("cpus")).frame(width: 130)
            Text("Up to \(maxCpus.formatted())").font(.caption).foregroundStyle(.secondary)
          }
        }
        Button("Use profile allocation") { request.overrides?.execution = nil }
        if let maximum = backend?["maxTotalMemoryGb"]?.number { Text("Main container and sidecars share a maximum of \(maximum.formatted()) GB per pod.").font(.caption).foregroundStyle(.secondary) }
        if !sidecars.isEmpty {
          Divider()
          Text("Sidecars").font(.headline)
          ForEach(Array(sidecars.enumerated()), id: \.offset) { _, sidecar in
            let id = sidecar["id"]?.string ?? ""
            let startup = sidecar["startup"]?.string ?? "on-demand"
            Toggle("\(id) · \(sidecar["type"]?.string ?? "service")\(startup == "always" ? " · always starts" : "")", isOn: Binding(get: {
              startup == "always" || selectedSidecars.contains(id)
            }, set: { enabled in
              var selected = selectedSidecars.filter { $0 != id }
              if enabled { selected.append(id) }
              request.requiredSidecarIds = selected
            })).disabled(startup == "always" || startup == "disabled" || backend?["sidecars"]?.bool != true)
            if backend?["sidecars"]?.bool == true && (startup == "always" || selectedSidecars.contains(id)) {
              HStack {
                Text("Memory (GB)"); TextField("Default", text: allocationText("memoryGb", sidecarId: id)).frame(width: 90)
                Text("CPUs"); TextField("Default", text: allocationText("cpus", sidecarId: id)).frame(width: 90)
              }.font(.callout).padding(.leading)
            }
          }
          Button("Use profile sidecars") { request.requiredSidecarIds = nil }
          Text("Hosted sandbox does not support sidecars. Selected sidecars are checked before launch.").font(.caption).foregroundStyle(.secondary)
        }
      }.padding(.top, 8)
    }
  }
  private func allocationChoice(_ key: String) -> Binding<String> {
    Binding(get: {
      guard let value = request.overrides?.execution?["main"]?[key] else { return "profile" }
      return value.number.map { String($0) } ?? "backend"
    }, set: { value in
      if request.overrides == nil { request.overrides = LaunchOverrides() }
      var execution = request.overrides?.execution ?? [:]
      var main = execution["main"]?.object ?? [:]
      if value == "profile" { main[key] = nil }
      else if value == "backend" { main[key] = .null }
      else if let amount = Double(value), amount.isFinite && amount > 0 { main[key] = .number(amount) }
      execution["main"] = .object(main); request.overrides?.execution = execution
    })
  }
  private func allocationText(_ key: String, sidecarId: String? = nil) -> Binding<String> {
    Binding(get: {
      let values: ConfigurationJSON?
      if let id = sidecarId { values = request.overrides?.execution?["sidecars"]?[id] }
      else { values = request.overrides?.execution?["main"] }
      return values?[key]?.number.map { String($0) } ?? ""
    }, set: { value in
      guard value.isEmpty || (Double(value).map { $0.isFinite && $0 > 0 } ?? false) else { return }
      if request.overrides == nil { request.overrides = LaunchOverrides() }
      var execution = request.overrides?.execution ?? [:]
      var values: [String: ConfigurationJSON]
      if let id = sidecarId { values = execution["sidecars"]?[id]?.object ?? [:] }
      else { values = execution["main"]?.object ?? [:] }
      values[key] = Double(value).map(ConfigurationJSON.number) ?? .null
      if let id = sidecarId { var sidecars = execution["sidecars"]?.object ?? [:]; sidecars[id] = .object(values); execution["sidecars"] = .object(sidecars) }
      else { execution["main"] = .object(values) }
      request.overrides?.execution = execution
    })
  }
}
