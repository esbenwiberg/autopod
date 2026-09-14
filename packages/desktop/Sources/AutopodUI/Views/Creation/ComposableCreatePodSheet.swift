import AutopodClient
import SwiftUI

public struct ComposableCreatePodSheet: View {
  @Binding var isPresented: Bool
  public var actions: LaunchConfigurationActions
  @State private var request = ComposableLaunchRequest()
  @State private var preview: EffectiveLaunchPreview?
  @State private var previewRequest: ComposableLaunchRequest?
  @State private var pendingRequest: ComposableLaunchRequest?
  @State private var busy = false
  @State private var error: String?
  @State private var showPim = false
  @State private var showSaveProfile = false
  @State private var advanced = ""
  @State private var showAdvanced = false
  public init(isPresented: Binding<Bool>, actions: LaunchConfigurationActions) { self._isPresented = isPresented; self.actions = actions }
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
  private var canPreview: Bool { !request.task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (request.repositoryId != nil || request.emptyWorkspace == true) && (profileID != nil) }
  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack { Text("New pod").font(.title2.bold()); Spacer(); Button("Close") { isPresented = false }.disabled(busy) }.padding()
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if let loadError = actions.loadError { Text(loadError).foregroundStyle(.red); Button("Reload configuration") { Task { await actions.reload() } } }
          GroupBox {
            VStack(alignment: .leading, spacing: 12) {
              Picker("Repository", selection: Binding(get: { request.emptyWorkspace == true ? "__empty" : request.repositoryId ?? "" }, set: { id in
                if id == "__empty" { request.repositoryId = nil; request.repositorySetupId = nil; request.emptyWorkspace = true }
                else { request.select(.repository, id: id.isEmpty ? nil : id) }
              })) {
                Text("Select repository").tag("")
                ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
                Text("Empty workspace").tag("__empty")
              }
              if let setups = repository?.payload["setups"]?.array, setups.count > 1 {
                Picker("Project setup", selection: Binding(get: { request.repositorySetupId ?? "" }, set: { request.repositorySetupId = $0.isEmpty ? nil : $0 })) {
                  Text("Repository default").tag("")
                  ForEach(Array(setups.enumerated()), id: \.offset) { _, setup in Text(setup["name"]?.string ?? "Setup").tag(setup["id"]?.string ?? "") }
                }
              }
              Picker("Profile", selection: Binding(get: { request.profileId ?? "" }, set: { request.select(.profile, id: $0.isEmpty ? nil : $0) })) {
                Text(repository == nil ? "Select profile" : "Repository default").tag("")
                ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
              }
              Picker("Intent", selection: Binding(get: { request.intent ?? "" }, set: { request.intent = $0.isEmpty ? nil : $0 })) {
                Text("Workflow default").tag(""); Text("Task").tag("task"); Text("Goal").tag("goal").disabled(!nativeGoalAvailable)
              }.pickerStyle(.segmented)
              if !nativeGoalAvailable { Text("Native Goals are not yet verified for this AI account and execution backend. Task mode is available.").font(.caption).foregroundStyle(.secondary) }
              Text(request.intent == "goal" ? "Objective" : "Task or objective").font(.headline)
              TextEditor(text: $request.task).frame(minHeight: 90).font(.body).overlay(RoundedRectangle(cornerRadius: 5).stroke(.quaternary))
            }.padding(8)
          }
          VStack(spacing: 12) {
            presetRow(.environment, key: "environmentId", selected: request.selections?.environmentId, edited: request.overrides?.environment != nil)
            presetRow(.ai, key: "aiId", selected: request.selections?.aiId, edited: request.overrides?.ai != nil)
            presetRow(.workflow, key: "workflowId", selected: request.selections?.workflowId, edited: request.overrides?.workflow != nil)
            githubRow
            toolPacksRow
          }
          executionRow
          DisclosureGroup("PIM access · \(effectivePim.count) selected") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(Array(effectivePim.enumerated()), id: \.offset) { _, selection in
                Text("\(selection["displayName"]?.string ?? "Role") · \(selection["scope"]?.string ?? "")").font(.callout)
              }
              HStack {
                Button("Choose eligible access") { showPim = true }
                Button("Use profile default") { request.overrides?.pim = nil }.disabled(request.overrides?.pim == nil)
                Button("Clear") { if request.overrides == nil { request.overrides = LaunchOverrides() }; request.overrides?.pim = [] }
              }
              Text("Selections use the same account. Choosing access here does not activate it.").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
          }
          DisclosureGroup("Full launch configuration", isExpanded: $showAdvanced) {
            VStack(alignment: .leading) {
              Text("Includes reference repositories, sidecar allocations, complete access rules and all preset overrides.").font(.caption).foregroundStyle(.secondary)
              TextEditor(text: $advanced).font(.system(.caption, design: .monospaced)).frame(minHeight: 200)
              HStack {
                Button("Load current values") { updateAdvanced() }
                Button("Apply JSON") { do { request = try ComposableLaunchRequest.decodeJSON(Data(advanced.utf8)); error = nil } catch { self.error = error.localizedDescription } }
              }
            }
          }.onChange(of: showAdvanced) { _, expanded in if expanded { updateAdvanced() } }
        }.padding().disabled(busy || pendingRequest != nil)
      }
      Divider()
      VStack(alignment: .leading, spacing: 8) {
        if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        if let preview {
          Text("\(preview.mainModel) · \(preview.executionTarget) · \(preview.memoryGb.map { String($0) } ?? "default") GB · \(preview.intent.capitalized)")
          DisclosureGroup("Resolved settings and value sources") { ScrollView { Text(ConfigurationJSON.object(preview.fields).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.frame(maxHeight: 170) }
        }
        if !launchAvailable { Text(actions.capabilities["launchUnavailableReason"]?.string ?? "Launch is unavailable until daemon configuration migration and execution checks are complete.").font(.caption).foregroundStyle(.secondary) }
        HStack {
          if busy { ProgressView().controlSize(.small) }
          Spacer()
          if pendingRequest != nil {
            Button("Edit a different launch") { pendingRequest = nil; preview = nil; previewRequest = nil }
            Button("Retry saved launch") { Task { await submit() } }.disabled(busy)
          } else {
            Button("Save as profile") { showSaveProfile = true }.disabled(busy || preview == nil || previewRequest != request)
            Button("Preview") { Task { await resolve() } }.disabled(busy || !canPreview)
            Button("Launch pod") { Task { await submit() } }.buttonStyle(.borderedProminent).disabled(busy || preview == nil || previewRequest != request || !launchAvailable)
          }
        }
      }.padding()
    }
    .frame(minWidth: 680, idealWidth: 780, minHeight: 700, idealHeight: 850)
    .onChange(of: request) { _, _ in preview = nil; previewRequest = nil }
    .sheet(isPresented: $showPim) {
      PimSelectionSheet(selected: effectivePim, discover: actions.discoverPim) { selections in
        if request.overrides == nil { request.overrides = LaunchOverrides() }; request.overrides?.pim = selections
      }
    }
    .sheet(isPresented: $showSaveProfile) {
      if let preview {
        SaveLaunchProfileSheet(request: request, preview: preview, actions: actions) { id in
          request.profileId = id
          request.selections = nil
          request.overrides = nil
          request.requiredSidecarIds = nil
        }
      }
    }
  }
  private func presetRow(_ kind: ConfigurationKind, key: String, selected: String?, edited: Bool) -> some View {
    DisclosureGroup("\(kind.label)\(edited ? " · edited" : "")") {
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
    DisclosureGroup("GitHub access\(request.overrides?.githubAccess != nil ? " · edited" : "")") {
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
    DisclosureGroup("Tool packs") {
      VStack(alignment: .leading) {
        ForEach(actions.list(.toolPack)) { pack in
          Toggle(pack.name, isOn: Binding(get: { selectedToolPacks.contains(pack.id) }, set: { enabled in
            var ids = selectedToolPacks; ids.removeAll { $0 == pack.id }; if enabled { ids.append(pack.id) }
            if request.selections == nil { request.selections = LaunchSelections() }; request.selections?.toolPackIds = ids; request.overrides?.toolPacks = nil
          }))
        }
        Button("Use profile defaults") { request.selections?.toolPackIds = nil; request.overrides?.toolPacks = nil }
      }.padding(.top, 8)
    }
  }
  private var selectedToolPacks: [String] { request.selections?.toolPackIds ?? profile?.payload["toolPackIds"]?.array?.compactMap(\.string) ?? [] }
  private var executionRow: some View {
    DisclosureGroup("Execution and size") {
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
  private func updateAdvanced() { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; advanced = (try? String(decoding: encoder.encode(request), as: UTF8.self)) ?? "{}" }
  private func resolve() async {
    busy = true; error = nil; let candidate = request
    defer { busy = false }
    do { let resolved = try await actions.resolve(candidate); guard request == candidate else { return }; preview = resolved; previewRequest = candidate }
    catch { self.error = error.localizedDescription }
  }
  private func submit() async {
    if pendingRequest == nil {
      guard let preview, previewRequest == request, !preview.digest.isEmpty else { return }
      var candidate = request; candidate.expectedDigest = preview.digest; candidate.requestId = UUID().uuidString
      pendingRequest = candidate
    }
    guard let candidate = pendingRequest else { return }
    busy = true; error = nil; defer { busy = false }
    do { _ = try await actions.launch(candidate); isPresented = false }
    catch { self.error = "\(error.localizedDescription)\nThe launch request is retained. Retry it to avoid creating a duplicate pod." }
  }
}
