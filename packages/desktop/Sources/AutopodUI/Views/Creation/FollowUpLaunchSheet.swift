import AutopodClient
import SwiftUI

internal struct FollowUpSourceContext: View {
  let pod: Pod
  var repository: String? = nil
  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .center, spacing: 24) { identity; Spacer(); metadata }
      VStack(alignment: .leading, spacing: 12) { identity; metadata }
    }.padding(.horizontal, 24).padding(.vertical, 16).background(DesktopTheme.sidebar)
  }
  private var identity: some View {
    VStack(alignment: .leading, spacing: 5) {
      Label(repository ?? DesktopRepository.resolve(pod, profiles: [])?.label ?? "Repository unavailable", systemImage: "shippingbox")
        .font(.caption).foregroundStyle(DesktopTheme.accent)
      Text(pod.desktopTitle).font(.headline).lineLimit(2)
      Text("\(pod.id) · \(pod.branch)").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
    }
  }
  private var metadata: some View {
    HStack(spacing: 20) {
      VStack(alignment: .leading, spacing: 5) { Text("Source state").foregroundStyle(.secondary); Text(pod.status.label) }
      if let name = pod.seriesName { VStack(alignment: .leading, spacing: 5) { Text("Series").foregroundStyle(.secondary); Text(name) } }
      if let milestone = pod.desktopMilestoneToken {
        VStack(alignment: .leading, spacing: 5) { Text(milestone); Text(pod.phase?.description ?? "Agent-reported progress").foregroundStyle(.secondary).lineLimit(2) }
          .padding(9).overlay(RoundedRectangle(cornerRadius: 5).stroke(DesktopTheme.line))
      }
    }.font(.caption)
  }
}

internal struct FollowUpLaunchSheet: View {
  @Binding var isPresented: Bool
  let candidatePods: [Pod]
  let actions: LaunchConfigurationActions
  var onCreated: ((String) -> Void)?
  @State private var model: FollowUpLaunchModel
  @State private var stage: LaunchComposerStage = .compose
  @State private var confirmClose = false
  init(isPresented: Binding<Bool>, kind: FollowUpLaunchKind, initiator: Pod, candidatePods: [Pod], actions: LaunchConfigurationActions,
    onCreated: ((String) -> Void)? = nil, model: FollowUpLaunchModel? = nil) {
    self._isPresented = isPresented; self.candidatePods = candidatePods; self.actions = actions; self.onCreated = onCreated
    self._model = State(initialValue: model ?? FollowUpLaunchModel(kind: kind, initiator: initiator, connectionID: actions.connectionID))
  }
  private var candidates: [Pod] {
    var seen = Set<String>()
    return candidatePods.filter { seen.insert($0.id).inserted }
  }
  private var selectable: [Pod] {
    var visible = candidates
    if !visible.contains(where: { $0.id == model.initiator.id }), model.parents.contains(model.initiator.id) { visible.append(model.initiator) }
    return visible.filter { model.parents.contains($0.id) || ![.failed, .killed, .killing].contains($0.status) }
  }
  private var repository: String {
    guard let source = model.source else { return DesktopRepository.resolve(model.initiator, profiles: [])?.label ?? "Loading repository…" }
    if source.fields["repository"] == nil || source.fields["repository"] == .null { return "Empty workspace" }
    let id = source.fields["repository"]?["id"]?.string
    return actions.list(.repository).first { $0.id == id }?.name
      ?? source.fields["repository"]?["config"]?["remote"]?.string.flatMap { DesktopRepository(url: $0)?.label }
      ?? id ?? "Source repository"
  }
  var body: some View {
    @Bindable var model = model
    LaunchComposerLayout(series: false, stage: $stage, locked: model.pending != nil, busy: model.busy, ready: model.ready,
      close: close, title: model.kind == .dependent ? "New dependent pod" : "Fork pod",
      subtitle: "Carry the source context into a new launch.", composeTitle: model.kind == .dependent ? "Task & parents" : "Task & source",
      sourcePod: candidates.first { $0.id == model.initiator.id } ?? model.initiator, sourceRepository: repository) {
      if let pending = model.pending {
        LaunchRetainedRequest(id: pending.requestId ?? "", payload: LaunchComposerJSON.value(pending))
      } else if model.source == nil {
        if model.busy { ProgressView("Loading source snapshot…") }
        else {
          ContentUnavailableView("Source configuration unavailable", systemImage: "link.badge.plus", description: Text("Your task stays in the draft. Reload the stored snapshot before continuing."))
          Button("Reload source snapshot") { Task { await model.refreshSource(actions) } }.accessibilityIdentifier("followup-refresh-source")
        }
      } else {
        Group {
          switch stage {
          case .compose: taskContent
          case .configure:
            Picker("Configuration source", selection: $model.original) {
              Text("Original snapshot").tag(true); Text("Current configuration").tag(false)
            }.pickerStyle(.segmented).accessibilityIdentifier("followup-configuration-source")
            if model.original {
              Text("Original settings are frozen. Only task and work context change. Preset edits do not change this snapshot.").font(.callout).foregroundStyle(.secondary)
              if let source = model.source { FollowUpFrozenConfiguration(source: source) }
            } else {
              Picker("Profile", selection: Binding(get: { model.selection.profileId ?? "" }, set: { model.selection.profileId = $0.isEmpty ? nil : $0 })) {
                Text("Repository usual profile").tag("")
                ForEach(actions.list(.profile)) { Text($0.name).tag($0.id) }
              }
              LaunchConfigurationEditor(request: $model.selection, actions: actions, jsonDirty: $model.jsonDirty,
                followUpSelectionOnly: true, advanced: $model.advanced)
            }
          case .review:
            Text(model.ready ? "Ready to create a new pod." : "Inspect the resolved follow-up.").font(.title2.weight(.semibold))
            effect
            if model.ready, let preview = model.preview {
              LaunchResolvedReview(preview: preview, compact: true)
              DisclosureGroup("Inspect complete request") { Text(LaunchComposerJSON.value(model.request).formatted()).font(.caption.monospaced()).textSelection(.enabled) }
            } else { Text("Preview checks the source binding, dependencies and effective configuration. No work is created by previewing.").foregroundStyle(.secondary) }
          }
        }.disabled(model.busy)
      }
    } summary: {
      summary
    } footer: {
      footer
    }
    .task { if model.source == nil { await model.refreshSource(actions) } }
    .onChange(of: model.request) { old, new in model.invalidate(); if old.source != nil && new.source != nil { model.dirty = true } }
    .onChange(of: model.jsonDirty) { _, value in if value { model.invalidate(); model.dirty = true } }
    .onChange(of: actions.documents) { _, _ in if model.pending == nil { model.invalidate() } }
    .onChange(of: actions.capabilities) { _, _ in if model.pending == nil { model.invalidate() } }
    .onChange(of: model.createdID) { _, id in if let id { onCreated?(id); isPresented = false } }
    .interactiveDismissDisabled(model.busy || model.dirty || model.jsonDirty || model.pending != nil)
    .confirmationDialog("Leave this follow-up draft?", isPresented: $confirmClose) {
      Button("Leave draft", role: .destructive) { isPresented = false }
      Button("Keep working", role: .cancel) {}
    } message: {
      Text(model.pending == nil ? "Unsubmitted choices will be discarded." : "The outcome is still unconfirmed. The exact launch request is saved in ~/.autopod/launches for recovery; keep this composer open to retry here.")
    }
  }
  private func close() { if model.dirty || model.jsonDirty || model.pending != nil { confirmClose = true } else { isPresented = false } }
  private var taskContent: some View {
    @Bindable var model = model
    return VStack(alignment: .leading, spacing: 18) {
      Text(model.kind == .dependent ? "What comes after this work?" : "Where should this fork take the work?").font(.title2.weight(.semibold))
      Text("Follow-up task").font(.headline)
      TextEditor(text: $model.selection.task).font(.body).scrollContentBackground(.hidden).frame(minHeight: 140)
        .padding(12).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesktopTheme.line)).accessibilityIdentifier("followup-task")
      if model.kind == .dependent {
        HStack { Text("Wait for these parents").font(.headline); Spacer(); Text("\(model.parents.count) selected").font(.caption).foregroundStyle(.secondary) }
        ForEach(selectable) { pod in
          Toggle(isOn: Binding(get: { model.parents.contains(pod.id) }, set: { if $0 { model.parents.insert(pod.id) } else { model.parents.remove(pod.id) } })) {
            HStack {
              VStack(alignment: .leading, spacing: 5) { Text(pod.desktopTitle).lineLimit(2); Text("\(pod.id) · \(candidates.contains(where: { $0.id == pod.id }) ? pod.status.label : "Unavailable")").font(.caption).foregroundStyle(.secondary) }
              Spacer(); if pod.id == model.initiator.id { Text("Source").font(.caption).foregroundStyle(.secondary) }
            }
          }.toggleStyle(.checkbox).padding(13).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 6))
            .accessibilityIdentifier("followup-parent-\(pod.id)")
        }
        Text("The initiating pod can be removed. The daemon enforces readiness for every selected parent; the new pod stays queued until those conditions are met.").font(.caption).foregroundStyle(.secondary)
        Picker("Series placement", selection: $model.series) {
          if model.initiator.seriesId != nil { Text("Join \(model.initiator.seriesName ?? "source series")").tag(FollowUpSeriesPlacement.inherit) }
          Text("Start a new series").tag(FollowUpSeriesPlacement.new)
          Text("Standalone").tag(FollowUpSeriesPlacement.standalone)
        }
        if model.series == .new { TextField("New series name", text: $model.seriesName).textFieldStyle(.roundedBorder) }
        TextField("Base branch · optional", text: $model.baseBranch).textFieldStyle(.roundedBorder)
        if model.series == .inherit, model.source?.fields["work"]?["prMode"]?.string == "single" {
          Text("Single-PR series · uses source work branch \(model.initiator.branch).").font(.caption).foregroundStyle(.secondary)
        }
      } else { effect }
    }
  }
  private var effect: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(model.kind == .dependent ? "NEW POD / WAITS FOR PARENTS" : "NEW POD / STARTS FROM SOURCE BRANCH").font(.caption2).foregroundStyle(DesktopTheme.accent)
      Text(model.kind == .dependent ? "\(model.parents.count) explicit parent dependencies" : model.initiator.branch).font(.headline)
      Text(model.selection.task).font(.callout).textSelection(.enabled)
      if model.kind == .fork { Text("New pod and worktree · source pod retains its identity. Base / delivery target: \(model.initiator.baseBranch ?? "repository default").").font(.caption).foregroundStyle(.secondary) }
    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(DesktopTheme.selection, in: RoundedRectangle(cornerRadius: 7))
  }
  private var summary: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("FOLLOW-UP SNAPSHOT").font(.caption2).tracking(1.2).foregroundStyle(.secondary)
      Text(model.pending != nil ? "Result unconfirmed" : model.ready ? "Preview ready" : "Needs preview").font(.caption).foregroundStyle(DesktopTheme.accent)
      Text(repository).font(.headline)
      Text("Source repository locked").font(.caption).foregroundStyle(.secondary)
      Divider()
      Text(model.original ? "Frozen original configuration" : "Current configuration").font(.headline)
      if model.original, let source = model.source {
        Text(source.mainModel).font(.callout)
        Text("\(source.executionTarget == "local" ? "Docker" : source.executionTarget) · \(source.memoryGb?.formatted() ?? "default") GB").font(.callout)
        Text(source.digest).font(.caption2.monospaced()).textSelection(.enabled)
      } else {
        let context = LaunchComposerContext(request: model.request, actions: actions, preview: model.ready ? model.preview : nil)
        Text(context.value(.ai)).font(.callout); Text(context.value(.execution)).font(.callout)
      }
      Divider()
      Text(model.kind == .dependent ? "\(model.parents.count) selected parents" : "Start branch").font(.caption).foregroundStyle(.secondary)
      if model.kind == .fork { Text(model.initiator.branch).font(.callout).textSelection(.enabled) }
      else { Text(model.series == .inherit ? model.initiator.seriesName ?? "Source series" : model.series == .new ? model.seriesName : "Standalone").font(.callout) }
      Text("Edits require a fresh preview. No completion-time or cost estimate is assumed.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private var footer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let error = model.error { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
      if let reason = model.validation(candidates: candidates), model.pending == nil { Text(reason).font(.caption).foregroundStyle(.secondary) }
      HStack {
        if model.busy { ProgressView().controlSize(.small) }
        Spacer()
        if model.pending != nil {
          Button("Retry saved launch") { Task { await model.submit(actions, candidates: candidates) } }.buttonStyle(.borderedProminent)
            .disabled(model.busy).accessibilityIdentifier("followup-retry")
        } else {
          Button("Refresh source snapshot") { Task { await model.refreshSource(actions) } }.disabled(model.busy).accessibilityIdentifier("followup-refresh-source")
          Button("Preview follow-up") { Task { await model.resolve(actions, candidates: candidates); if model.ready { stage = .review } } }
            .disabled(model.busy || model.validation(candidates: candidates) != nil || actions.capabilities["launchAvailable"]?.bool != true)
            .accessibilityIdentifier("followup-preview")
          Button(model.kind == .dependent ? "Create dependent pod" : "Create fork") { Task { await model.submit(actions, candidates: candidates) } }
            .buttonStyle(.borderedProminent).disabled(model.busy || !model.ready || model.validation(candidates: candidates) != nil || actions.capabilities["launchAvailable"]?.bool != true)
            .accessibilityIdentifier("followup-submit")
        }
      }
    }
  }
}

internal struct FollowUpFrozenConfiguration: View {
  let source: EffectiveLaunchPreview
  private let categories = ["environment", "ai", "workflow", "resolvedExecution", "githubAccess", "toolPacks", "pim", "requiredSidecarIds", "referenceRepositories"]
  @State private var inspected: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 14)], spacing: 14) {
        ForEach(categories, id: \.self) { key in
          Button { inspected = key } label: {
            VStack(alignment: .leading, spacing: 12) {
              HStack { Text(title(key)).font(.subheadline.weight(.semibold)); Spacer(); Image(systemName: "lock") }
              Text(value(key)).font(.headline).frame(minHeight: 32, alignment: .topLeading)
              Text("Stored snapshot · inspect ↗").font(.caption).foregroundStyle(DesktopTheme.accent)
            }.padding(17).frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
              .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
              .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesktopTheme.line))
          }.buttonStyle(.plain).accessibilityIdentifier("followup-frozen-\(key)")
        }
      }
      DisclosureGroup("Complete stored snapshot & value sources") {
        Text(ConfigurationJSON.object(source.fields).formatted()).font(.caption.monospaced()).textSelection(.enabled)
      }
    }
    .sheet(isPresented: Binding(get: { inspected != nil }, set: { if !$0 { inspected = nil } })) {
      VStack(alignment: .leading, spacing: 18) {
        HStack { Text(title(inspected ?? "")).font(.title2.weight(.semibold)); Spacer(); Button("Close") { inspected = nil } }
        Text("Read-only original configuration. Choose Current configuration to change launch selections.").font(.callout).foregroundStyle(.secondary)
        ScrollView { Text((source.fields[inspected ?? ""] ?? .null).formatted()).font(.callout.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
      }.padding(24).frame(width: 650, height: 500).background(DesktopTheme.canvas)
    }
  }
  private func title(_ key: String) -> String {
    switch key {
    case "environment": "Environment"; case "ai": "AI route"; case "workflow": "Workflow"
    case "resolvedExecution": "Execution & allocation"; case "githubAccess": "Agent GitHub access"
    case "toolPacks": "Tool packs"; case "pim": "PIM selections"; case "requiredSidecarIds": "Required sidecars"
    case "referenceRepositories": "References"; default: "Stored configuration"
    }
  }
  private func value(_ key: String) -> String {
    let data = source.fields[key]
    switch key {
    case "ai": return source.mainModel
    case "resolvedExecution": return "\(source.executionTarget == "local" ? "Docker" : source.executionTarget) · \(source.memoryGb?.formatted() ?? "default") GB"
    case "workflow": return [data?["output"]?.string, data?["completion"]?.string].compactMap { $0 }.joined(separator: " · ")
    case "githubAccess" where data == .null: return "No agent access"
    case "toolPacks", "pim", "requiredSidecarIds", "referenceRepositories": return data?.array.map { "\($0.count) selected" } ?? "Not supplied"
    default: return data?["name"]?.string ?? (data == nil ? "Not supplied" : "Frozen values")
    }
  }
}
