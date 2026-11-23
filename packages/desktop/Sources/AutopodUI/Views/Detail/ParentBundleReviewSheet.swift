import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ParentBundleReviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  @State private var handoff = ParentBundleHandoff()
  @State private var operation: ParentBundleHandoff.Work? = .preview

  let target: ParentBundleTarget
  let actions: ParentBundleActions
  let isCurrent: @MainActor @Sendable () -> Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Review private bundle").font(.title2.weight(.semibold))
      Text("Checks and independent review passed on this exact Git tree. Approval unlocks its private download. It does not publish a PR or merge anything.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      if let review = handoff.review {
        ScrollView {
          VStack(alignment: .leading, spacing: 10) {
            digest("Commit", review.commit)
            digest("Tree", review.tree)
            digest("Bundle SHA-256", review.bundleDigest)
            if let base = review.bundleBaseCommit {
              Text("This bundle contains only the changes. To open it with Git, use a checkout that already contains the base commit below.")
                .font(.caption).foregroundStyle(.secondary)
              digest("Required base commit", base)
            }
            Text("Changed files (\(review.paths.count))").font(.caption.weight(.semibold))
            ForEach(Array(review.paths.enumerated()), id: \.offset) { _, path in
              Text(path).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
            DisclosureGroup("Receipt details") {
              VStack(alignment: .leading, spacing: 8) {
                digest("Checks receipt", review.checks)
                digest("Independent review receipt", review.independentReview)
                digest("Evidence", review.evidenceDigest)
              }.padding(.top, 6)
            }.font(.caption)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 130, maxHeight: 300)
      }

      if handoff.approval != nil {
        Label("Private download approved", systemImage: "checkmark.circle")
          .font(.subheadline.weight(.medium))
      }
      if let notice = handoff.notice {
        Text(notice).font(.caption).foregroundStyle(.secondary)
          .accessibilityIdentifier("parent-bundle-notice")
      }
      HStack {
        if let work = handoff.work {
          ProgressView().controlSize(.small)
          Text(work == .preview ? "Loading preview…" : work == .approve ? "Confirming approval…" : "Verifying and saving…")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
        if handoff.approval != nil {
          Button("Save verified bundle…") { operation = .save }
            .buttonStyle(.borderedProminent)
            .disabled(!readyForAction)
            .accessibilityIdentifier("parent-bundle-save")
        } else if handoff.review != nil {
          Button("Approve private download") { operation = .approve }
            .buttonStyle(.borderedProminent)
            .disabled(!readyForAction)
            .accessibilityIdentifier("parent-bundle-approve")
        }
      }
    }
    .padding(24)
    .frame(width: 560)
    .task(id: operation) {
      guard let operation else { return }
      switch operation {
      case .preview:
        await handoff.load(target.selection, actions: actions, isCurrent: isCurrent)
      case .approve:
        await handoff.approve(target.selection, actions: actions, isCurrent: isCurrent)
      case .save:
        await handoff.save(target.selection, actions: actions, isCurrent: isCurrent) { suggestedName in
          let panel = NSSavePanel()
          panel.title = "Save private Git bundle"
          panel.nameFieldStringValue = suggestedName
          if let type = UTType(filenameExtension: "bundle", conformingTo: .data) {
            panel.allowedContentTypes = [type]
          }
          return await panel.begin() == .OK ? panel.url : nil
        }
      }
      self.operation = nil
    }
    .onDisappear { handoff.close() }
  }

  private var readyForAction: Bool {
    operation == nil && handoff.work == nil && actions.isCurrent(target.selection) && isCurrent()
  }

  private func digest(_ title: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
      Text(value).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
    }
  }
}
