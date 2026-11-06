import AutopodClient
import SwiftUI

/// Discoverability is not eligibility. Opening the sheet performs GETs only.
struct RepairContinuationCard: View {
  let podId: String
  let actions: RepairContinuationActions
  @State private var showSheet = false
  var body: some View {
    HStack {
      Label("Preserve work · inspect environment replacement", systemImage: "wrench.and.screwdriver")
      Spacer()
      Button("Inspect repair & continuation…") { showSheet = true }
        .accessibilityIdentifier("repair-continuation-open")
    }.font(.callout).padding(10).background(.orange.opacity(0.08))
      .sheet(isPresented: $showSheet) { RepairContinuationSheet(podId: podId, actions: actions) }
  }
}

struct RepairContinuationSheet: View {
  let actions: RepairContinuationActions
  @State private var model: RepairContinuationModel
  @State private var confirmation = false
  @Environment(\.dismiss) private var dismiss

  init(podId: String, actions: RepairContinuationActions, model: RepairContinuationModel? = nil) {
    self.actions = actions
    _model = State(initialValue: model ?? RepairContinuationModel(podId: podId, actions: actions))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Repair environment & continue coding").font(.title2.bold())
        Spacer()
        Button("Inspect / refresh") { Task { await model.refresh(actions) } }
          .disabled(model.busy).accessibilityIdentifier("repair-continuation-refresh")
        Button("Done") { dismiss() }.disabled(model.busy).keyboardShortcut(.cancelAction)
      }
      Text(model.podId).font(.caption.monospaced()).textSelection(.enabled)
      Text("One conditional attempt: provision the reviewed replacement, qualify its actual resource, then start ONE fresh coding segment only IF it qualifies. Configuration preview is not proof and cannot skip probes.")
        .font(.callout).accessibilityIdentifier("repair-continuation-conditional")
      if model.busy { ProgressView().controlSize(.small) }
      if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled).accessibilityIdentifier("repair-continuation-error") }
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let snapshot = model.snapshot {
            Text("Generation \(snapshot.generation) · \(snapshot.available ? "inspect supported static selection" : "unsupported or refused")")
            Text("Result hash: \(snapshot.expectedResultHash ?? "unavailable")\nComplete report-set hash: \(snapshot.expectedReportSetHash ?? "unavailable")")
              .font(.caption.monospaced()).textSelection(.enabled)
            refusals(snapshot.refusals)
          } else {
            Text("A compatible repair-continuation-v1 observation is required. Missing/old responses do not enable authorization.")
          }
          if let pending = model.pending {
            Text("Saved request: \(pending.id)\nHOST HEAD: \(pending.sourceHead)\nProfile: \(pending.executionProfileId)\nReason: \(pending.reason)")
              .font(.caption).textSelection(.enabled).accessibilityIdentifier("repair-continuation-saved")
            Text("The exact request survives closing/reopening. Observe is GET only. A missing receipt, timeout or quiet sandbox does not prove failed dispatch; do not create a new key.")
              .font(.callout)
            Button("Observe saved request") { Task { await model.observe(actions) } }
              .disabled(model.busy).accessibilityIdentifier("repair-continuation-observe")
          } else {
            TextField("Exact retained HOST HEAD", text: $model.hostHead)
              .textFieldStyle(.roundedBorder).font(.caption.monospaced()).disabled(model.busy)
              .accessibilityIdentifier("repair-continuation-head")
            Text("Selected host Git source is not a claim to contain original final sandbox bytes. Original files, ignored/unsynced data, reports and resources remain retained; no deletion is authorized.")
              .font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("repair-continuation-source-warning")
            TextField("Reviewed replacement profile ID", text: $model.profileId)
              .textFieldStyle(.roundedBorder).disabled(model.busy).accessibilityIdentifier("repair-continuation-profile")
            if let preview = model.preview {
              Text("Configuration only · actual qualification: \(preview.actualQualification)\nConditional attempt: \(preview.conditionalAttemptEligible ? "supported — not qualified" : "refused")")
                .font(.headline).accessibilityIdentifier("repair-continuation-preview-state")
              if let diff = preview.configurationDiff {
                execution("Before", diff.before)
                execution("After", diff.after)
              }
              if let selected = preview.selection {
                Text("Preview digest: \(selected.expectedExecutionDigest)\nBinding: \(selected.expectedBindingDigest)")
                  .font(.caption.monospaced()).textSelection(.enabled)
              }
              refusals(preview.refusals)
            }
            TextField("Reason for this conditional repair (10–4000 characters)", text: $model.reason, axis: .vertical)
              .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(model.busy).accessibilityIdentifier("repair-continuation-reason")
          }
          if let operation = model.operation {
            Text("Observed operation: \(operation.state.rawValue)").font(.headline).accessibilityIdentifier("repair-continuation-stage")
            Text("Qualification: \(operation.qualification?.outcome.rawValue ?? "not run")\nCoding admission: \(operation.codingAdmission.rawValue)\nChecks: \(operation.checks.rawValue)")
              .textSelection(.enabled)
            if let proof = operation.qualification {
              Text("Actual resource: \(proof.binding.containerId)\nImage: \(proof.binding.expectedImage.digest)\nQualification expires: \(proof.expiresAt)")
                .font(.caption.monospaced()).textSelection(.enabled)
            }
            if let final = operation.codingFinalSource {
              Text("Sealed final source (distinct from selected input): \(final.source.head)").font(.caption.monospaced()).textSelection(.enabled)
            }
            refusals(operation.refusals)
            Text("Accepted is not qualified, admitted is not completed, and passed checks are not delivery approval. Fresh human approval remains required; publication is not authorized.")
              .font(.callout).foregroundStyle(.secondary)
          }
          context
          Text("Frozen: repository, task, AI/account/runtime/model, workflow, network, credentials/PIM, actions, tool packs and permissions. Cumulative budgets/history are not reset. Retry grants or budget increases require their separate owning controls; this sheet issues neither.")
            .font(.caption).foregroundStyle(.secondary)
          Text("Other operations stay separate: Start sandbox for file recovery is machine-only; retained continuation runs checks only; Resume delivery may publish previously checked work. None is a fallback for unavailable repair support.")
            .font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      if model.pending == nil {
        HStack {
          Button("Preview configuration") { Task { await model.loadPreview(actions) } }
            .disabled(!model.canPreview).accessibilityIdentifier("repair-continuation-preview")
          Spacer()
          Button("Authorize repair and one coding continuation…") { confirmation = true }
            .disabled(!model.canAuthorize).buttonStyle(.borderedProminent).accessibilityIdentifier("repair-continuation-authorize")
        }
      }
    }.padding(20).frame(width: 780, height: 710)
      .background(Color(nsColor: .windowBackgroundColor))
      .interactiveDismissDisabled(model.busy)
      .task { await model.refresh(actions) }
      .confirmationDialog("Authorize this exact conditional attempt?", isPresented: $confirmation, titleVisibility: .visible) {
        Button("Authorize provision + qualification + one coding segment IF qualified") { Task { await model.authorize(actions) } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Original work/resources remain retained. The daemon must qualify the actual replacement resource before coding. This is not a retry grant, a budget reset, a waiver, or publication/merge approval. Configured checks and independent review still run.")
      }
  }

  private func execution(_ title: String, _ value: RepairExecutionDisplayV1) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("\(title): \(value.target) / \(value.template) / \(value.platform)").font(.headline)
      Text("Memory: \(value.memoryGb.formatted()) GiB · CPUs: \(value.cpus.map { String($0) } ?? "unknown")\nImage key: \(value.imageKey)").font(.caption.monospaced()).textSelection(.enabled)
    }.accessibilityIdentifier("repair-continuation-diff-\(title.lowercased())")
  }
  @ViewBuilder private func refusals(_ values: [RepairContinuationRefusal]) -> some View {
    ForEach(Array(values.enumerated()), id: \.offset) { _, value in
      Text("Refused [\(value.code)]: \(value.message)").foregroundStyle(.orange).textSelection(.enabled)
    }
  }
  @ViewBuilder private var context: some View {
    if let context = model.context {
      DisclosureGroup("Original preservation / report needs (historical, not repair proof)") {
        if let original = context.retained?.inspection {
          Text("Source preservation: \(original.prerequisites.sourcePreservationRecorded ? "recorded" : "not recorded"); worker settlement: \(original.prerequisites.workerSettlementRecorded ? "recorded" : "not recorded"); pending decision: \(original.prerequisites.pendingDecision ? "yes" : "none recorded")")
          Text("Needs state: \(original.infrastructure.state)")
          ForEach(Array(original.infrastructure.needs.prefix(20).enumerated()), id: \.offset) { _, need in
            Text("\(need.owner ?? "unknown owner") / \(need.phase ?? "unknown phase"): \(need.needs ?? "not recorded")\(need.truncated ? " [truncated — inspect original report]" : "")")
          }
          if original.infrastructure.truncated || original.infrastructure.needs.count > 20 { Text("More needs omitted. Inspect original reports; no requirement is waived.") }
        } else { Text("Original preservation/report observation unavailable.") }
        Text("Historical NOT-RUN checks remain incomplete and visible in new reviews; neither human authorization nor qualification passes them.")
      }
      DisclosureGroup("Cumulative budget / retry limits — separate decisions") {
        if let budget = context.budget {
          Text("Task: \(budget.taskId) · recorded tokens: \(budget.recordedTotalTokens.map(String.init) ?? "unavailable") · limit: \(budget.tokenBudget.map(String.init) ?? "not configured / unavailable") · telemetry: \(budget.telemetry)")
          Text("Budget admission: \(budget.budgetCheck?.status ?? "unavailable") — \(budget.budgetCheck?.reason ?? "unknown, not permission")")
          Text("Recorded usage is not a reservation of future provider spending.")
        } else { Text("Cumulative usage/limit unavailable, not zero or unlimited permission.") }
        ForEach(Array(context.retries.enumerated()), id: \.offset) { _, retry in
          Text("\(retry.stage): \(retry.admissionCount) admissions / \(retry.executedCount) executions · latest \(retry.latest?.id ?? "unavailable") / \(retry.latest?.outcome ?? "unknown") · cooldown \(retry.latest?.providerRetryNotBefore ?? "none recorded") · telemetry \(retry.telemetry)")
          ForEach(retry.authorizations) { grant in Text("Grant \(grant.id), failure \(grant.failureId): \(grant.usedByAttemptId == nil ? "unused recorded decision" : "consumed")") }
        }
        ForEach(Array(context.unavailable.enumerated()), id: \.offset) { _, message in Text(message).foregroundStyle(.orange) }
      }.font(.caption).textSelection(.enabled)
    }
  }
}
