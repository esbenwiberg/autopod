import AutopodClient
import SwiftUI

struct AnalysisWorkspaceLauncher: View {
  let kind: String
  let actions: LaunchConfigurationActions?
  @State private var showing = false
  var body: some View {
    Button(kind == "history" ? "Open History Workspace…" : "Open Memory Workspace…") { showing = true }
      .disabled(actions == nil)
      .sheet(isPresented: $showing) {
        if let actions { AnalysisWorkspaceSheet(kind: kind, actions: actions) }
      }
  }
}

private struct AnalysisWorkspaceSheet: View {
  let kind: String
  let actions: LaunchConfigurationActions
  @Environment(\.dismiss) private var dismiss
  @State private var selection: [String: ConfigurationJSON] = [:]
  @State private var allRepositories = false
  @State private var failuresOnly = false
  @State private var limit = 100
  @State private var request: ComposableLaunchRequest?
  @State private var preview: EffectiveLaunchPreview?
  @State private var busy = false
  @State private var error: String?

  private var task: String {
    kind == "history" ? "Analyze the exported pod history in /history."
      : "Review /history/memories.md against this repository and draft a prioritized fix plan."
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(kind == "history" ? "History workspace" : "Memory workspace").font(.title2.bold())
      Text("Select a repository and reusable configuration. This launch opens an interactive Task workspace.")
        .foregroundStyle(.secondary)
      ScrollView {
        ScheduledLaunchSelectionEditor(actions: actions, selection: $selection, task: task)
        if kind == "history" {
          Toggle("Include history from all repositories", isOn: $allRepositories)
          Toggle("Failures only", isOn: $failuresOnly)
          Picker("Pods", selection: $limit) {
            ForEach([50, 100, 200, 1000], id: \.self) { Text("Last \($0)").tag($0) }
          }
          Text("Project history uses recorded repository identity. Older pods without that identity are available under all repositories.")
            .font(.caption).foregroundStyle(.secondary)
        } else {
          Text("Includes approved global memories and memories for this repository and project setup.")
            .font(.caption).foregroundStyle(.secondary)
        }
        if let preview {
          Divider()
          Text("\(preview.repositoryName) · \(preview.mainModel) · \(preview.executionTarget)")
          Text("Interactive Task · branch output for a repository · no automatic delivery").font(.caption)
        }
      }.disabled(busy)
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      HStack {
        Button("Cancel") { dismiss() }.disabled(busy)
        Spacer()
        Button("Preview") { Task { await resolve() } }.disabled(busy)
        Button("Launch") { Task { await launch() } }
          .buttonStyle(.borderedProminent).disabled(busy || request == nil)
      }
    }
    .padding(24).frame(width: 660, height: 720)
    .onChange(of: selection) { _, _ in invalidate() }
    .onChange(of: allRepositories) { _, _ in invalidate() }
    .onChange(of: failuresOnly) { _, _ in invalidate() }
    .onChange(of: limit) { _, _ in invalidate() }
  }
  private func invalidate() { request = nil; preview = nil; error = nil }
  private func resolve() async {
    busy = true; error = nil; request = nil; preview = nil
    defer { busy = false }
    do {
      var fields = selection
      fields["task"] = .string(task); fields["intent"] = .string("task")
      var overrides = fields["overrides"]?.object ?? [:]
      var workflow = overrides["workflow"]?.object ?? [:]
      workflow["agentMode"] = .string("interactive"); workflow["promotable"] = .bool(false)
      workflow["output"] = .string(fields["emptyWorkspace"]?.bool == true ? "artifact" : "branch")
      workflow["completion"] = .string("approval"); workflow["validationPhases"] = .array([])
      workflow["advisoryBrowserQaEnabled"] = .bool(false)
      overrides["workflow"] = .object(workflow); fields["overrides"] = .object(overrides)
      fields["work"] = .object(["analysis": .object(kind == "history"
        ? ["kind": .string(kind), "scope": .string(allRepositories ? "all" : "repository"),
           "limit": .number(Double(limit)), "failuresOnly": .bool(failuresOnly)]
        : ["kind": .string(kind)])])
      var pending = try ComposableLaunchRequest.decodeJSON(JSONEncoder().encode(fields))
      pending.requestId = UUID().uuidString
      let effective = try await actions.resolve(pending)
      pending.expectedDigest = effective.digest
      request = pending; preview = effective
    } catch { self.error = error.localizedDescription }
  }
  private func launch() async {
    guard let request else { return }
    busy = true; error = nil
    defer { busy = false }
    do { _ = try await actions.launch(request); dismiss() }
    catch { self.error = error.localizedDescription }
  }
}
