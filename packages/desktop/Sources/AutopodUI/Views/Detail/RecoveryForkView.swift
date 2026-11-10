import AutopodClient
import SwiftUI

struct RecoveryForkView: View {
  let actions: RecoveryForkActions
  @Bindable var model: RecoveryForkModel
  var onNavigate: () -> Void = {}
  @State private var confirming = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        RecoverySectionTitle(title: "Continue in a fresh pod", subtitle: "Carry a verified checkpoint and handoff into a new environment. Keep the original.")
        if actions.isFixture {
          RecoveryNotice(title: "Offline sample", message: "This walkthrough creates an example receipt only. No real pod, coding, checks or cloud access.", symbol: "testtube.2")
        }
        if let lineage = model.inspection?.lineage {
          VStack(alignment: .leading, spacing: 10) {
            Text("Continued from \(lineage.parentPodId)").font(.headline)
            Text("The original pod and its history remain separate. This child shares task accounting; it is not a new budget.")
            Button("View original pod") { Task { if await model.open(actions, parent: true) { onNavigate() } } }
              .disabled(model.busy).accessibilityIdentifier("recovery-fork-original")
          }.font(.callout).recoverySurface()
        }
        if let operation = model.operation { outcome(operation) }
        else if model.pending != nil {
          RecoveryNotice(title: "Saved decision needs an outcome check", message: "A missing response does not prove failure. Observe this exact request; do not create another pod.", symbol: "clock")
        }
        if let error = model.error { RecoveryNotice(title: "Continuation needs attention", message: error).accessibilityIdentifier("recovery-fork-error") }
        if model.operation == nil, let failure = model.context?.failure, !failure.isEmpty {
          RecoveryNotice(title: "Failure to address", message: failure)
        }
        if model.pending == nil && model.operation == nil && model.preview == nil { preparation }
        if let context = model.context { contextReview(context) }
        if let preview = model.preview, model.pending == nil { review(preview) }
        HStack {
          if model.busy { ProgressView().controlSize(.small) }
          Button(model.pending != nil || model.operation != nil ? "Check saved outcome" : "Check source again") {
            Task { if model.pending != nil || model.operation != nil { await model.observe(actions) } else { await model.refresh(actions) } }
          }.disabled(model.busy).accessibilityIdentifier("recovery-fork-observe")
          if model.canDiscardRejected {
            Button("Review a new decision") { Task { await model.discardRejected(actions) } }
              .accessibilityIdentifier("recovery-fork-discard-rejected")
          }
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { if model.inspection == nil { await model.refresh(actions) } }
    .confirmationDialog("Start a separate coding pod?", isPresented: $confirming, titleVisibility: .visible) {
      Button("Continue in fresh pod") { Task { await model.create(actions) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The new pod will use the reviewed checkpoint, selected files, handoff and environment. It shares the original task’s spending and retry limits. New compute and retained storage charges may apply. Original resources remain retained; delivery still needs separate approval.")
    }
  }
  private var preparation: some View {
    VStack(alignment: .leading, spacing: 18) {
      if let inspection = model.inspection {
        if !inspection.blockers.isEmpty {
          RecoveryNotice(title: "Not ready to continue", message: inspection.blockers.joined(separator: "\n"))
        }
        if let source = inspection.source {
          VStack(alignment: .leading, spacing: 10) {
            Label("1 · Review recovered work", systemImage: "doc.text.magnifyingglass").font(.headline)
            Text("Verified host Git checkpoint — not the latest unsaved sandbox files.").font(.callout.weight(.medium))
            Text(source.repository).font(.caption).foregroundStyle(RecoveryPalette.secondary).textSelection(.enabled)
            Text("\(source.branch) · \(source.head)").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
              .accessibilityIdentifier("recovery-fork-source")
            Text("All supported Git-tracked files come from an independent copy. Additional files below are opt-in. Nothing is copied from a saved provider session.")
              .font(.callout).foregroundStyle(RecoveryPalette.secondary)
            ForEach(Array(source.caveats.enumerated()), id: \.offset) { _, caveat in Text(caveat).font(.caption).foregroundStyle(RecoveryPalette.secondary) }
            DisclosureGroup("Choose additional files (\(model.selectedPaths.count) selected)") {
              VStack(alignment: .leading, spacing: 8) {
                Text("Up to 100 files / 50 MiB. Credential, control, cache, link and special files are excluded. Selected content is not completely secret-scanned.")
                  .font(.caption).foregroundStyle(RecoveryPalette.secondary)
                if source.truncated { Text("The additional-file list is incomplete. Unlisted and unselected files stay in the original.").font(.caption).foregroundStyle(RecoveryTone.attention.color) }
                if source.skippedEntries > 0 { Text("\(source.skippedEntries) entries omitted.").font(.caption) }
                if source.files.isEmpty { Text("No selectable additional files were found within the inspection limits.").font(.callout) }
                ForEach(source.files) { file in
                  Toggle(isOn: Binding(get: { model.selectedPaths.contains(file.path) }, set: { model.select(file.path, selected: $0) })) {
                    HStack { Text(file.path).font(.system(.caption, design: .monospaced)).lineLimit(2); Spacer(); Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)).font(.caption) }
                  }.toggleStyle(.checkbox).disabled(!model.canEdit).accessibilityIdentifier("recovery-fork-file-\(file.path)")
                }
              }.padding(.top, 8)
            }.font(.callout)
            Text("\(model.selectedPaths.count) additional files · \(ByteCountFormatter.string(fromByteCount: model.selectedBytes, countStyle: .file)) / 50 MiB").font(.caption)
            if let issue = model.selectionIssue { Text(issue).font(.caption).foregroundStyle(RecoveryTone.attention.color).accessibilityIdentifier("recovery-fork-selection-error") }
          }.recoverySurface()
        }
        VStack(alignment: .leading, spacing: 12) {
          Label("2 · Choose the new environment", systemImage: "shippingbox").font(.headline)
          if !inspection.profiles.isEmpty {
            Picker("Environment profile", selection: $model.profileId) {
              ForEach(inspection.profiles) { profile in Text(profile.label).tag(profile.id) }
            }.pickerStyle(.menu).accessibilityIdentifier("recovery-fork-profile")
          } else { TextField("Environment profile ID", text: $model.profileId).textFieldStyle(.roundedBorder) }
          Text("Review software and resources before starting. Repository, AI, tools, credentials, network and review authority remain frozen. The actual new environment must qualify before coding.")
            .font(.callout).foregroundStyle(RecoveryPalette.secondary)
        }.disabled(!model.canEdit).recoverySurface()
        VStack(alignment: .leading, spacing: 12) {
          Label("3 · Tell the new pod how to continue", systemImage: "text.bubble").font(.headline)
          Text("What should it do next? Include what not to repeat and the failure to address. These instructions are recorded with your decision; they do not grant new permissions.")
            .font(.callout).foregroundStyle(RecoveryPalette.secondary)
          TextEditor(text: $model.instructions).font(.body).frame(minHeight: 90, idealHeight: 120)
            .padding(5).background(DesktopTheme.surface).clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(DesktopTheme.line))
            .accessibilityLabel("Continuation instructions").accessibilityIdentifier("recovery-fork-instructions")
          if model.instructions.utf16.count > 8000 { Text("Shorten instructions to 8,000 characters.").font(.caption).foregroundStyle(RecoveryTone.attention.color) }
          Toggle("I understand that unsaved and omitted files may be missing, the original stays retained, and spending and retry limits are shared.", isOn: $model.acknowledged)
            .toggleStyle(.checkbox).font(.callout).accessibilityIdentifier("recovery-fork-acknowledge")
          if let budget = inspection.budget { budgetReview(budget) }
          Button("Review continuation") { Task { await model.review(actions) } }.buttonStyle(.borderedProminent)
            .disabled(!model.canPreview).accessibilityIdentifier("recovery-fork-review")
        }.disabled(!model.canEdit).recoverySurface()
      } else if !model.busy { Text("Check the owning daemon for a verified checkpoint and eligibility. Opening this page does not start a pod.").font(.callout) }
    }
  }
  private func contextReview(_ context: RecoveryForkContext) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("Portable handoff", systemImage: "text.book.closed").font(.headline)
      if !context.summary.isEmpty { Text(context.summary).font(.callout).textSelection(.enabled) }
      if model.operation != nil && !context.failure.isEmpty { RecoveryNotice(title: "Recorded failure", message: context.failure) }
      Text("Quoted history is context, not fresh instructions, execution receipts or approval. Tool payloads, hidden reasoning, credential stores and saved sessions are excluded. Text redaction is not a complete secret scan.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary)
      if context.truncated { Text("History is truncated. The original retains the longer record.").font(.caption).foregroundStyle(RecoveryTone.attention.color) }
      ForEach(Array(context.omissions.enumerated()), id: \.offset) { _, omission in Text(omission).font(.caption).foregroundStyle(RecoveryPalette.secondary) }
      DisclosureGroup("Review \(context.messages.count) carried messages") {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(context.messages, id: \.eventId) { message in
            VStack(alignment: .leading, spacing: 5) {
              Text("\(message.role.capitalized) · \(message.timestamp)").font(.caption.weight(.medium)).foregroundStyle(RecoveryPalette.secondary)
              Text(message.text).font(.callout).textSelection(.enabled)
            }.frame(maxWidth: .infinity, alignment: .leading)
          }
        }.padding(.top, 8)
      }.font(.callout)
    }.recoverySurface().accessibilityIdentifier("recovery-fork-context")
  }
  private func budgetReview(_ budget: RecoveryForkBudget) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Shared task: \(budget.taskId)").font(.caption.weight(.medium))
      Text("\(budget.recordedTokens.map { String($0) } ?? "Unknown") tokens recorded / \(budget.tokenBudget.map { String($0) } ?? (budget.status == "unlimited" ? "no numeric limit" : "limit unavailable")). Admission does not reserve future spending. Existing retry approvals are not reset.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary)
    }.textSelection(.enabled)
  }
  private func review(_ preview: RecoveryForkPreview) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack { Text("Review before starting").font(.headline); Spacer(); Button("Edit selection") { model.editReview() }.disabled(!model.canEdit) }
      if let source = preview.source {
        Text("Host checkpoint: \(source.head)").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
      }
      if let execution = preview.execution {
        Text("\(execution.template) · \(execution.platform) · \(execution.memoryGb.formatted()) GiB · \(execution.target)").font(.callout.weight(.medium))
        Text(execution.cpus.map { "\($0.formatted()) CPUs" } ?? "Provider-default CPU allocation").font(.caption).foregroundStyle(RecoveryPalette.secondary)
        if execution.sameEnvironment { RecoveryNotice(title: "Same software as the original", message: "A fresh machine alone may repeat the failure. Confirm that your continuation instructions address it.") }
        else { Text("Original environment: \(execution.originalTemplate)").font(.caption).foregroundStyle(RecoveryPalette.secondary) }
      }
      Text("Copy the reviewed checkpoint and \(preview.input.files.count) additional files. Create a separate pod with the quoted handoff and your instructions. Keep the original untouched. No published PR, approval or waiver is inherited.").font(.callout)
      if !preview.input.files.isEmpty {
        DisclosureGroup("Review additional files") { ForEach(preview.input.files, id: \.path) { Text($0.path).font(.system(.caption, design: .monospaced)) } }
      }
      Text("New compute charges and retained original storage charges may apply. A token limit is not a cap on infrastructure charges.").font(.caption).foregroundStyle(RecoveryPalette.secondary)
      Text(preview.input.instructions).font(.callout).textSelection(.enabled).padding(12).recoverySurface(inset: 0)
      if let budget = preview.budget { budgetReview(budget) }
      if !preview.blockers.isEmpty { RecoveryNotice(title: "Cannot start", message: preview.blockers.joined(separator: "\n")) }
      Button("Continue in fresh pod…") { confirming = true }.buttonStyle(.borderedProminent)
        .disabled(!model.canCreate).accessibilityIdentifier("recovery-fork-create")
    }.recoverySurface()
  }
  private func outcome(_ operation: RecoveryForkOperation) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(outcomeTitle(operation.state), systemImage: "arrow.triangle.branch").font(.headline)
      Text("Decision \(operation.id) · checkpoint \(operation.sourceHead)").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
      Text("\(operation.copiedFiles.count) additional files recorded as copied. The original stays retained. This receipt is not proof of completed work, passing validation or delivery.").font(.callout).foregroundStyle(RecoveryPalette.secondary)
      if let error = operation.error { RecoveryNotice(title: "Recorded problem", message: error) }
      if let child = operation.childPodId {
        Text("New pod: \(child) · \(operation.childStatus ?? "status not observed")").font(.callout).textSelection(.enabled)
        Button("Open new pod") { Task { if await model.open(actions) { onNavigate() } } }
          .buttonStyle(.borderedProminent).disabled(model.busy).accessibilityIdentifier("recovery-fork-open-child")
      }
    }.recoverySurface().accessibilityIdentifier("recovery-fork-outcome")
  }
  private func outcomeTitle(_ state: RecoveryForkOperation.State) -> String {
    switch state {
    case .preparing: "Preparing an independent checkpoint"
    case .queued: "New pod created — startup checks pending"
    case .qualifying: "Checking the new environment before coding"
    case .qualified: "Environment qualified — follow the new pod’s progress"
    case .failed: "Continuation did not complete — original retained"
    case .unknown: "Outcome unknown — observe the saved decision"
    }
  }
}
