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
  let embedded: Bool
  @State private var model: RepairContinuationModel
  @State private var confirmation = false
  @Environment(\.dismiss) private var dismiss

  init(podId: String, actions: RepairContinuationActions, model: RepairContinuationModel? = nil, embedded: Bool = false) {
    self.actions = actions; self.embedded = embedded
    _model = State(initialValue: model ?? RepairContinuationModel(podId: podId, actions: actions))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Use a replacement environment").font(.title2.bold())
        Spacer()
        Button("Inspect / refresh") { Task { await model.refresh(actions) } }
          .disabled(model.busy).accessibilityIdentifier("repair-continuation-refresh")
        if !embedded { Button("Done") { dismiss() }.disabled(model.busy).keyboardShortcut(.cancelAction) }
      }
      Text("Review the saved source and replacement settings. The daemon will prepare and test the actual replacement before allowing one coding continuation. If it does not qualify, coding will not start.")
        .font(.callout).accessibilityIdentifier("repair-continuation-conditional")
      if model.busy { ProgressView().controlSize(.small) }
      if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled).accessibilityIdentifier("repair-continuation-error") }
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let snapshot = model.snapshot {
            Text(snapshot.available ? "Review a replacement before authorizing any coding." : "A replacement cannot be authorized yet.")
              .font(.headline)
            refusals(snapshot.refusals)
            DisclosureGroup("Technical selection details") {
              Text("Pod: \(model.podId) · generation \(snapshot.generation)\nResult: \(snapshot.expectedResultHash ?? "unavailable")\nReport set: \(snapshot.expectedReportSetHash ?? "unavailable")")
                .font(.caption.monospaced()).textSelection(.enabled)
            }
          } else {
            Text("A compatible repair-continuation-v1 observation is required. Missing/old responses do not enable authorization.")
          }
          if let pending = model.pending {
            Text("A repair decision is already saved").font(.headline)
            Text("Environment profile: \(pending.executionProfileId) · source \(pending.sourceHead.prefix(12))\nReason: \(pending.reason)")
              .font(.callout).textSelection(.enabled).accessibilityIdentifier("repair-continuation-saved")
            Text("Check its outcome rather than starting another repair. Closing this window keeps the exact saved decision; a lost response does not prove that nothing happened.")
              .font(.callout)
            Button("Check the saved repair outcome") { Task { await model.observe(actions) } }
              .disabled(model.busy).accessibilityIdentifier("repair-continuation-observe")
          } else {
            Text("1. Choose the saved source").font(.headline)
            Text("Enter the full saved host commit you intend to repair. This connection does not automatically discover a safe source; an older checkpoint can omit newer work.")
              .font(.callout).foregroundStyle(.secondary)
            TextField("Saved source commit (full SHA)", text: $model.hostHead)
              .textFieldStyle(.roundedBorder).font(.caption.monospaced()).disabled(model.busy)
              .accessibilityIdentifier("repair-continuation-head")
            Text("Selected host Git source is not a claim to contain original final sandbox bytes. Original files, ignored/unsynced data, reports and resources remain retained; no deletion is authorized.")
              .font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("repair-continuation-source-warning")
            Text("2. Choose the replacement").font(.headline)
            TextField("Reviewed environment profile ID", text: $model.profileId)
              .textFieldStyle(.roundedBorder).disabled(model.busy).accessibilityIdentifier("repair-continuation-profile")
            if let preview = model.preview {
              Text(preview.conditionalAttemptEligible ? "Settings preview ready — actual environment not yet tested" : "These settings cannot be used yet")
                .font(.headline).accessibilityIdentifier("repair-continuation-preview-state")
              if let diff = preview.configurationDiff {
                execution("Before", diff.before)
                execution("After", diff.after)
              }
              if let selected = preview.selection {
                DisclosureGroup("Exact preview identity") {
                  Text("Preview digest: \(selected.expectedExecutionDigest)\nBinding: \(selected.expectedBindingDigest)")
                    .font(.caption.monospaced()).textSelection(.enabled)
                }
              }
              refusals(preview.refusals)
            }
            Text("3. Review and authorize").font(.headline)
            TextField("Why use this replacement? (10–4000 characters)", text: $model.reason, axis: .vertical)
              .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(model.busy).accessibilityIdentifier("repair-continuation-reason")
          }
          if let operation = model.operation {
            Text(repairProgressDescription(operation.state)).font(.headline).accessibilityIdentifier("repair-continuation-stage")
            Text("Retained operation/custody: \(operation.operationId)").font(.caption.monospaced()).textSelection(.enabled)
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
          Text("Original files and resources stay retained. Existing retry permissions and budgets still apply. This does not publish or merge; passing checks still requires human approval.")
            .font(.callout).foregroundStyle(.secondary)
          DisclosureGroup("Original reports, limits and unchanged permissions") {
            context
            Text("Repository, task, AI/account/runtime/model, workflow, network, credentials/PIM, actions, tool packs and permissions remain frozen. This action grants no extra retries or budget.")
              .font(.caption).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      if model.pending == nil {
        HStack {
          Button("Preview replacement settings") { Task { await model.loadPreview(actions) } }
            .disabled(!model.canPreview).accessibilityIdentifier("repair-continuation-preview")
          Spacer()
          Button("Prepare replacement and continue if qualified…") { confirmation = true }
            .disabled(!model.canAuthorize).buttonStyle(.borderedProminent).accessibilityIdentifier("repair-continuation-authorize")
        }
      }
    }.padding(embedded ? 0 : 20).frame(width: embedded ? nil : 780, height: embedded ? nil : 710)
      .background(Color(nsColor: .windowBackgroundColor))
      .interactiveDismissDisabled(model.busy)
      .task { await model.refresh(actions) }
      .confirmationDialog("Authorize this exact conditional attempt?", isPresented: $confirmation, titleVisibility: .visible) {
        Button("Prepare, verify and continue once if qualified") { Task { await model.authorize(actions) } }
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
      Text("Cannot proceed yet: \(value.message)").foregroundStyle(.orange).textSelection(.enabled)
      DisclosureGroup("Blocker code") { Text(value.code).font(.caption.monospaced()).textSelection(.enabled) }
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
