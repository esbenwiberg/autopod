import AutopodClient
import SwiftUI

struct AnalysisWorkspaceLauncher: View {
  let kind: String
  let actions: LaunchConfigurationActions?
  @State private var showing = false
  var body: some View {
    Button(kind == "history" ? "Open History Workspace…" : "Open Memory Workspace…") {
      showing = true
    }
    .disabled(actions == nil)
    .sheet(isPresented: $showing) {
      if let actions { AnalysisWorkspaceSheet(kind: kind, actions: actions) }
    }
  }
}

struct AnalysisWorkspaceSheet: View {
  @Environment(\.desktopRedesign) private var redesign
  let kind: String
  let actions: LaunchConfigurationActions
  @Environment(\.dismiss) private var dismiss
  @State private var stage: LaunchComposerStage = .compose
  @State private var jsonDirty = false
  @State private var advanced = ""
  @State private var selection: [String: ConfigurationJSON] = [:]
  @State private var allRepositories = false
  @State private var failuresOnly = false
  @State private var limit = 100
  @State private var request: ComposableLaunchRequest?
  @State private var preview: EffectiveLaunchPreview?
  @State private var busy = false
  @State private var error: String?

  init(
    kind: String, actions: LaunchConfigurationActions,
    initialSelection: [String: ConfigurationJSON] = [:],
    initialStage: LaunchComposerStage = .compose
  ) {
    self.kind = kind
    self.actions = actions
    self._selection = State(initialValue: initialSelection)
    self._stage = State(initialValue: initialStage)
  }
  private var task: String {
    kind == "history"
      ? "Analyze the exported pod history in /history."
      : "Review /history/memories.md against this repository and draft a prioritized fix plan."
  }
  var body: some View {
    Group { if redesign { composer } else { legacyBody } }
      .onChange(of: selection) { _, _ in invalidate() }
      .onChange(of: allRepositories) { _, _ in invalidate() }
      .onChange(of: failuresOnly) { _, _ in invalidate() }
      .onChange(of: limit) { _, _ in invalidate() }
      .onChange(of: jsonDirty) { _, dirty in if dirty { invalidate() } }
      .interactiveDismissDisabled(busy)
  }

  private var draftRequest: ComposableLaunchRequest {
    (try? LaunchComposerJSON.decode(
      ConfigurationJSON.object(selection).formatted(), selectionOnly: true, task: task))
      ?? ComposableLaunchRequest()
  }
  private var draftBinding: Binding<ComposableLaunchRequest> {
    Binding(
      get: { draftRequest },
      set: { selection = LaunchComposerJSON.value($0, selectionOnly: true).object ?? [:] })
  }
  private var composer: some View {
    LaunchComposerLayout(
      series: false, stage: $stage, locked: false, busy: busy, ready: request != nil && !jsonDirty,
      close: { dismiss() }, title: kind == "history" ? "History workspace" : "Memory workspace",
      subtitle:
        "Choose the evidence, inspect the configuration, then open an interactive workspace.",
      eyebrow: "WORKSPACE / ANALYSIS", composeTitle: "Evidence"
    ) {
      Group {
        switch stage {
        case .compose:
          Text("What should this workspace inspect?").font(.title2.weight(.semibold))
          Text(task).foregroundStyle(.secondary)
          DesktopPanel(title: "Repository") {
            Picker(
              "Repository",
              selection: Binding(
                get: {
                  selection["emptyWorkspace"]?.bool == true
                    ? "__empty" : selection["repositoryId"]?.string ?? ""
                },
                set: { id in
                  selection.removeValue(forKey: "repositorySetupId")
                  selection.removeValue(forKey: "repositoryId")
                  selection.removeValue(forKey: "emptyWorkspace")
                  var overrides = selection["overrides"]?.object ?? [:]
                  overrides.removeValue(forKey: "repositorySetup")
                  selection["overrides"] = .object(overrides)
                  if id == "__empty" {
                    selection["emptyWorkspace"] = .bool(true)
                  } else if !id.isEmpty {
                    selection["repositoryId"] = .string(id)
                  }
                })
            ) {
              Text("Select repository").tag("")
              Text("Empty workspace").tag("__empty")
              ForEach(actions.list(.repository)) { Text($0.name).tag($0.id) }
            }.accessibilityIdentifier("analysis-repository")
            Picker(
              "Profile",
              selection: Binding(
                get: { selection["profileId"]?.string ?? "" },
                set: { id in
                  selection["profileId"] = id.isEmpty ? nil : .string(id)
                })
            ) {
              Text("Repository usual profile").tag("")
              ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
            }
          }
          DesktopPanel(title: "Evidence") {
            if kind == "history" {
              Toggle("Include history from all repositories", isOn: $allRepositories)
              Toggle("Failures only", isOn: $failuresOnly)
              Picker("Pods", selection: $limit) {
                ForEach([50, 100, 200, 1000], id: \.self) { Text("Last \($0)").tag($0) }
              }
            } else {
              Text(
                "Includes approved global memories and memories for this repository and project setup."
              )
            }
          }
        case .configure:
          LaunchConfigurationEditor(
            request: draftBinding, actions: actions, jsonDirty: $jsonDirty, selectionOnly: true,
            advanced: $advanced)
        case .review:
          if let preview, request != nil {
            LaunchResolvedReview(preview: preview)
          } else {
            ContentUnavailableView(
              "Preview this workspace", systemImage: "doc.text.magnifyingglass",
              description: Text("Resolve the current configuration before launching."))
          }
        }
      }.disabled(busy)
    } summary: {
      LaunchComposerSummary(
        context: .init(request: request ?? draftRequest, actions: actions, preview: preview),
        status: request == nil || jsonDirty ? "Needs preview" : "Preview ready")
      Text(
        selection["emptyWorkspace"]?.bool == true
          ? "Interactive Task · artifact output · no automatic delivery"
          : "Interactive Task · repository branch output · no automatic delivery"
      ).font(.caption)
        .foregroundStyle(.secondary)
    } footer: {
      VStack(alignment: .leading, spacing: 10) {
        if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        HStack {
          Text("Preview before launch").font(.caption).foregroundStyle(.secondary)
          Spacer()
          Button("Cancel") { dismiss() }.disabled(busy)
          Button("Inspect configuration →") { stage = .configure }.disabled(busy)
          Button("Preview workspace") {
            Task {
              await resolve()
              if request != nil { stage = .review }
            }
          }
          .disabled(
            busy || jsonDirty
              || (selection["repositoryId"]?.string == nil
                && selection["emptyWorkspace"]?.bool != true)
          )
          .accessibilityIdentifier("analysis-preview")
          Button("Launch workspace") { Task { await launch() } }.buttonStyle(.borderedProminent)
            .disabled(busy || jsonDirty || request == nil).accessibilityIdentifier(
              "analysis-launch")
        }
      }
    }
  }

  private var legacyBody: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !redesign {
        Text(kind == "history" ? "History workspace" : "Memory workspace").font(.title2.bold())
      }
      Text(
        "Select a repository and reusable configuration. This launch opens an interactive Task workspace."
      )
      .foregroundStyle(.secondary)
      ScrollView {
        ScheduledLaunchSelectionEditor(actions: actions, selection: $selection, task: task)
        if kind == "history" {
          Toggle("Include history from all repositories", isOn: $allRepositories)
          Toggle("Failures only", isOn: $failuresOnly)
          Picker("Pods", selection: $limit) {
            ForEach([50, 100, 200, 1000], id: \.self) { Text("Last \($0)").tag($0) }
          }
          Text(
            "Project history uses recorded repository identity. Older pods without that identity are available under all repositories."
          )
          .font(.caption).foregroundStyle(.secondary)
        } else {
          Text(
            "Includes approved global memories and memories for this repository and project setup."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        if let preview {
          Divider()
          Text("\(preview.repositoryName) · \(preview.mainModel) · \(preview.executionTarget)")
          Text("Interactive Task · branch output for a repository · no automatic delivery").font(
            .caption)
        }
      }.disabled(busy).desktopFormSection()
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack {
        Button("Cancel") { dismiss() }.disabled(busy)
        Spacer()
        Button("Preview") { Task { await resolve() } }.disabled(busy)
        Button("Launch") { Task { await launch() } }
          .buttonStyle(.borderedProminent).disabled(busy || request == nil)
      }.desktopDialogActions()
    }
    .desktopDialog(
      kind == "history" ? "Open History workspace" : "Open Memory workspace",
      eyebrow: "Workspace / Analysis",
      subtitle: "Choose the evidence and configuration for an interactive workspace.",
      width: 820, height: 800, legacyWidth: 660, legacyHeight: 720, legacyPadding: 24)
  }

  private func invalidate() {
    request = nil
    preview = nil
    error = nil
  }
  private func resolve() async {
    busy = true
    error = nil
    request = nil
    preview = nil
    defer { busy = false }
    do {
      var fields = selection
      fields["task"] = .string(task)
      fields["intent"] = .string("task")
      var overrides = fields["overrides"]?.object ?? [:]
      var workflow = overrides["workflow"]?.object ?? [:]
      workflow["agentMode"] = .string("interactive")
      workflow["promotable"] = .bool(false)
      workflow["output"] = .string(fields["emptyWorkspace"]?.bool == true ? "artifact" : "branch")
      workflow["completion"] = .string("approval")
      workflow["validationPhases"] = .array([])
      workflow["advisoryBrowserQaEnabled"] = .bool(false)
      overrides["workflow"] = .object(workflow)
      fields["overrides"] = .object(overrides)
      fields["work"] = .object([
        "analysis": .object(
          kind == "history"
            ? [
              "kind": .string(kind), "scope": .string(allRepositories ? "all" : "repository"),
              "limit": .number(Double(limit)), "failuresOnly": .bool(failuresOnly),
            ]
            : ["kind": .string(kind)])
      ])
      var pending = try ComposableLaunchRequest.decodeJSON(JSONEncoder().encode(fields))
      pending.requestId = UUID().uuidString
      let effective = try await actions.resolve(pending)
      pending.expectedDigest = effective.digest
      request = pending
      preview = effective
    } catch { self.error = error.localizedDescription }
  }
  private func launch() async {
    guard let request else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      _ = try await actions.launch(request)
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
