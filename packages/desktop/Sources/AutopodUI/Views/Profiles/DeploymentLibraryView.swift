import AutopodClient
import SwiftUI

struct DeploymentLibraryView: View {
  @Environment(\.desktopRedesign) private var redesign
  let actions: LaunchConfigurationActions
  @State private var runs: [ConfigurationJSON] = []
  @State private var review: ConfigurationJSON?
  @State private var uncertain: ConfigurationJSON?
  @State private var outcome = "not-deployed"
  @State private var note = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if redesign { Text("DELIVERY / DEPLOYMENTS").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary) }
      HStack { Text("Deployments").font(.title2.bold()); Spacer(); Button("Refresh") { Task { await reload() } }.disabled(busy) }
      Text("Deploy the published default branch. Review pins an exact commit; pod changes must be published first.").foregroundStyle(.secondary)
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      if busy { ProgressView().controlSize(.small) }
      if !redesign && runs.isEmpty { Text("No deployment requests. A pod or the CLI can request an allowed deployment.").foregroundStyle(.secondary) }
      if redesign {
        if runs.isEmpty {
          ContentUnavailableView("No deployment requests", systemImage: "shippingbox", description: Text("Deployment requests appear here for review before a published commit is deployed."))
        } else {
          ScrollView { LazyVStack(spacing: 12) {
            ForEach(Array(runs.enumerated()), id: \.offset) { _, run in deploymentRow(run).desktopFormSection() }
          }.padding(1) }
        }
      } else {
        List(Array(runs.enumerated()), id: \.offset) { _, run in deploymentRow(run) }
      }
    }.padding(redesign ? 26 : 16).background(redesign ? DesktopTheme.canvas : .clear)
    .task { while !Task.isCancelled { if !busy { await reload() }; do { try await Task.sleep(for: .seconds(5)) } catch { break } } }
    .sheet(isPresented: Binding(get: { review != nil }, set: { if !$0 { review = nil } })) {
      if let review, let run = review["run"] {
        VStack(alignment: .leading, spacing: 12) {
          if !redesign { Text("Review deployment").font(.title2.bold()) }
          Text("\(run["plan"]?["repositoryId"]?.string ?? "") → \(run["plan"]?["targetId"]?.string ?? "")").font(.headline)
          Text("Published default branch: \(run["plan"]?["sourceBranch"]?.string ?? "")")
          Text(run["plan"]?["sourceCommit"]?.string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          Text("Script: \(run["plan"]?["scriptPath"]?.string ?? "")")
          Text("Arguments: \(run["plan"]?["args"]?.formatted() ?? "[]")").textSelection(.enabled)
          ScrollView { Text(review["scriptContent"]?.string ?? "").font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(minHeight: 220)
          DisclosureGroup("Runner and approval details") {
            ScrollView { Text(ConfigurationJSON.object(["plan": run["plan"] ?? .null, "target": review["target"] ?? .null]).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.frame(height: 140)
          }
          if let error { Text(error).foregroundStyle(.red) }
          HStack { Button("Close") { self.review = nil }; Spacer(); Button("Approve this commit and deploy") { Task { await decide(run, "approve") } }.buttonStyle(.borderedProminent) }.disabled(busy)
        }.desktopDialog("Review deployment", eyebrow: "Delivery / Approval",
          subtitle: "Review the exact published commit and script before approving this deployment.",
          width: 880, height: 760, legacyWidth: 760, legacyHeight: 700, legacyPadding: 24)
      }
    }
    .sheet(isPresented: Binding(get: { uncertain != nil }, set: { if !$0 { uncertain = nil } })) {
      if let uncertain {
        VStack(alignment: .leading, spacing: 14) {
          if !redesign { Text("Reconcile deployment").font(.title2.bold()) }
          Text("Check the destination before continuing. AutoPod could not confirm the outcome and has blocked further deployments to this target.")
          Picker("Observed outcome", selection: $outcome) { Text("Not deployed").tag("not-deployed"); Text("Deployed").tag("deployed") }
          TextField("What did you check?", text: $note, axis: .vertical).lineLimit(3...5)
          if let error { Text(error).foregroundStyle(.red) }
          HStack { Button("Cancel") { self.uncertain = nil }; Spacer(); Button("Record outcome and release target") { Task {
            busy = true; defer { busy = false }
            do { _ = try await actions.reconcileDeployment(uncertain["id"]?.string ?? "", .object(["digest": uncertain["digest"] ?? .null, "externalOutcome": .string(outcome), "note": .string(note)])); self.uncertain = nil; await reload() }
            catch { self.error = error.localizedDescription }
          } }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.disabled(busy)
        }.desktopDialog("Reconcile deployment", eyebrow: "Delivery / Confirm outcome",
          subtitle: "Record what happened at the destination before releasing this target.", legacyWidth: 580, legacyPadding: 24)
      }
    }
  }
  @ViewBuilder private func deploymentRow(_ run: ConfigurationJSON) -> some View {
        let id = run["id"]?.string ?? ""
        let state = run["state"]?.string ?? "unknown"
        HStack {
          VStack(alignment: .leading) {
            Text("\(run["plan"]?["targetId"]?.string ?? "Deployment") · \(state.replacingOccurrences(of: "_", with: " "))").font(.headline)
            Text("\(run["plan"]?["repositoryId"]?.string ?? "") · \(run["plan"]?["sourceBranch"]?.string ?? "") · \(String((run["plan"]?["sourceCommit"]?.string ?? "").prefix(12)))").font(.caption).textSelection(.enabled)
            Text("Pod \(run["plan"]?["podId"]?.string ?? "")").font(.caption).foregroundStyle(.secondary)
            if let code = run["receipt"]?["exitCode"]?.number { Text("Script exit \(Int(code)) · runner removed").font(.caption) }
            if state == "reconciled" { Text("Operator confirmed: \(run["reconciliation"]?["externalOutcome"]?.string ?? "")").font(.caption) }
          }
          Spacer()
          if ["awaiting_approval", "approved"].contains(state) {
            Button("Review") { Task { busy = true; defer { busy = false }; do { review = try await actions.reviewDeployment(id) } catch { self.error = error.localizedDescription } } }.disabled(busy)
            Button("Deny") { Task { await decide(run, "deny") } }.disabled(busy)
          }
          if state == "uncertain" { Button("Reconcile") { uncertain = run; note = "" }.disabled(busy) }
        }.padding(.vertical, 5)
  }
  private func reload() async { do { runs = try await actions.listDeployments() } catch { self.error = error.localizedDescription } }
  private func decide(_ run: ConfigurationJSON, _ decision: String) async {
    busy = true; error = nil; defer { busy = false }
    do { _ = try await actions.decideDeployment(run["id"]?.string ?? "", .object(["digest": run["digest"] ?? .null, "decision": .string(decision)])); review = nil }
    catch { self.error = "\(error.localizedDescription) Check the deployment status before retrying." }
    await reload()
  }
}
