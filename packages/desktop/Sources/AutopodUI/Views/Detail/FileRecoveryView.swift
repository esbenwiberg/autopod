import AppKit
import AutopodClient
import SwiftUI

/// Saved copies first; machine start is a separate audited decision, never a read fallback.
struct FileRecoveryView: View {
  let actions: PodActions
  @State var model: FileRecoveryModel
  @State var sandbox: SandboxRecoveryModel
  var onOpenEvidence: (() -> Void)?
  var chooseCopyDestination: (@MainActor () async -> URL?)?
  @State private var startResource: SandboxRecoveryResource?
  @State private var search = ""
  @State private var startGeneration: Int?
  @State private var scrollRequest = 0
  @State private var scrollTarget = "file-selection"

  var body: some View {
    ScrollViewReader { proxy in
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack {
          RecoverySectionTitle(title: "Save a copy of your files", subtitle: "Browse a known source, select files, then choose where to save them on this Mac.")
          Spacer()
          Button("Refresh files") { Task { await refresh() } }.disabled(model.busy || sandbox.busy)
        }
        if actions.fileRecovery.isFixture {
          RecoveryNotice(title: "Sample files only", message: "These are example files, not your actual task. Saving creates a real local copy of sample data; no daemon or cloud environment is contacted.", tone: .standard, symbol: "info.circle")
        }
        if model.busy { ProgressView(model.copying ? "Copying selected files…" : "Checking available files…").controlSize(.small) }
        if let error = model.error { RecoveryNotice(title: "Files need attention", message: error) }
        if let snapshot = model.snapshot {
          VStack(alignment: .leading, spacing: 12) {
            RecoverySectionTitle(title: "1. Files already saved", subtitle: "These copies are on the daemon host. They may be older than files in the original environment.")
            let saved = snapshot.sources.filter { $0.kind == .saved }
            if saved.isEmpty { Text("No saved file locations are recorded. This does not mean the original environment is empty.").font(.callout) }
            ForEach(saved) { source in sourceChoice(source) }
          }.recoverySurface()
          VStack(alignment: .leading, spacing: 12) {
            RecoverySectionTitle(title: "2. Other files in the original environment", subtitle: "Use this if the saved copies do not contain what you need. Starting the machine does not resume the coding agent.")
            let originals = snapshot.sources.filter { $0.kind == .original }
            if originals.isEmpty { Text("No supported current retained sandbox is available here. Historical resources may still be held by another recovery.").font(.callout) }
            ForEach(originals) { source in
              if source.status == .available || source.status == .ready { sourceChoice(source) }
              else {
                Text(source.status == .stopped ? "The old environment is powered off." : "Original files are not available yet.").font(.callout.weight(.semibold))
                Text(source.detail).font(.callout).foregroundStyle(RecoveryPalette.secondary).textSelection(.enabled)
                if let resource = sandbox.snapshot?.resources.first(where: { $0.sandboxId == source.sandboxId }) {
                  if source.status == .stopped {
                    Button("Start old environment to inspect files…") { startGeneration = sandbox.snapshot?.generation; startResource = resource }
                      .disabled(!sandbox.canReviewStart(resource) || model.busy || model.snapshot?.generation != sandbox.snapshot?.generation)
                      .accessibilityIdentifier("file-recovery-review-start")
                    if let blocker = resource.startBlocked { Text(blocker).font(.callout).foregroundStyle(RecoveryPalette.secondary) }
                  }
                }
              }
            }
            if sandbox.pendingStart != nil || sandbox.recordedPending?.action == "start" {
              RecoveryNotice(title: "Check the earlier start", message: "Its outcome has not been confirmed. Refresh status; another start will not be sent.", symbol: "clock")
            }
            if sandbox.canDiscardRejectedStart {
              Button("Review a new start after confirmed rejection") { Task { await sandbox.discardRejected(actions.sandboxRecovery); await model.refresh(actions.fileRecovery) } }
            }
            if let error = sandbox.error { Text(error).font(.callout).foregroundStyle(RecoveryPalette.secondary) }
          }.frame(maxWidth: .infinity, alignment: .leading).recoverySurface()
          if let source = model.source, source.status == .available { browser(source, snapshot: snapshot).id("file-selection") }
          if !model.results.isEmpty { copyResults.id("copy-results") }
          DisclosureGroup("What this browser does not include") {
            VStack(alignment: .leading, spacing: 8) {
              Text("This is a selected-file copy, not a complete backup. Symlinks, hardlinks, special files, oversized files and common credential/cache locations are omitted. Content is not scanned for secrets; choose a trusted destination.")
              Text("Excluded names: \(snapshot.excludes.joined(separator: ", ")). Maximum file size: \(bytes(snapshot.limits.maxFileBytes)). Lists may be bounded or incomplete.")
              Text("A successful copy does not prove the environment is fully preserved, release source custody, or authorize deletion. Nothing is deleted automatically.")
            }.font(.caption).foregroundStyle(RecoveryPalette.secondary).padding(.top, 8)
          }
        }
        if onOpenEvidence != nil {
          Button("Open existing evidence and reports", action: { onOpenEvidence?() }).controlSize(.small).disabled(model.busy || sandbox.busy)
        }
        Text("No coding, checks, publication or deletion runs from file browsing or copying.")
          .font(.caption).foregroundStyle(RecoveryPalette.secondary)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .onChange(of: scrollRequest) { _, _ in proxy.scrollTo(scrollTarget, anchor: .top) }
    .onChange(of: model.selectedSourceID) { _, _ in search = "" }
    }
    .background(DesktopTheme.canvas).tint(DesktopTheme.accent)
    .task { await refresh() }
    .sheet(isPresented: Binding(get: { startResource != nil }, set: { if !$0 { startResource = nil } })) {
      if let resource = startResource { startReview(resource) }
    }
  }

  private func sourceChoice(_ source: RecoveryFileSource) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Image(systemName: source.kind == .saved ? "externaldrive" : "server.rack").accessibilityHidden(true)
        Text(source.label).font(.callout.weight(.semibold))
        Spacer()
        Text(source.status == .available ? "\(source.files.count) listed files" : source.status == .ready ? "Not inspected yet" : "Unavailable").font(.caption)
        Button(model.selectedSourceID == source.id ? "Showing files" : "Browse files") {
          if source.status == .ready { Task { await model.refresh(actions.fileRecovery, includeOriginal: true); scrollTarget = "file-selection"; scrollRequest += 1 } }
          else { model.select(source.id); scrollTarget = "file-selection"; scrollRequest += 1 }
        }
          .disabled(![.available, .ready].contains(source.status) || model.busy || sandbox.busy)
          .accessibilityIdentifier("file-recovery-source-\(source.id)")
      }
      Text(source.detail).font(.caption).foregroundStyle(RecoveryPalette.secondary)
      if source.truncated || source.skippedEntries > 0 {
        Text("\(source.truncated ? "Listing limit reached. " : "")\(source.skippedEntries) entries skipped. This is not a complete file inventory.")
          .font(.caption).foregroundStyle(RecoveryTone.attention.color)
      }
    }.padding(12).background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
  }

  private func browser(_ source: RecoveryFileSource, snapshot: RecoveryFilesSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      RecoverySectionTitle(title: "3. Select files to save", subtitle: "Showing: \(source.label). Sources are never silently substituted.")
      TextField("Filter file paths", text: $search).textFieldStyle(.roundedBorder).disabled(model.busy)
      let files = source.files.filter { search.isEmpty || $0.path.localizedCaseInsensitiveContains(search) }
      if files.isEmpty { Text("No matching files are listed in this source. Other files may be excluded or unavailable.").font(.callout) }
      else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(files) { file in
              Toggle(isOn: Binding(get: { model.selectedPaths.contains(file.path) }, set: { _ in model.toggle(file) })) {
                HStack(alignment: .firstTextBaseline) {
                  Text(file.path).font(.callout.monospaced()).textSelection(.enabled)
                  Spacer(minLength: 8)
                  Text(bytes(file.size)).font(.caption).foregroundStyle(RecoveryPalette.secondary)
                }
              }.toggleStyle(.checkbox).disabled(model.busy || sandbox.busy)
                .accessibilityIdentifier("file-recovery-file-\(file.path)")
            }
          }.padding(12)
        }.frame(height: min(280, CGFloat(files.count) * 32 + 24))
          .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
      }
      Text("\(model.selectedPaths.count) selected · \(bytes(model.selectedBytes)). Up to 100 files / \(bytes(snapshot.limits.maxSelectionBytes)) per copy.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary)
      HStack {
        Button("Save selected files to this Mac…") { Task { await model.copy(actions.fileRecovery, chooseDirectory: chooseCopyDestination ?? chooseDirectory); if !model.results.isEmpty { scrollTarget = "copy-results"; scrollRequest += 1 } } }
          .buttonStyle(.borderedProminent).disabled(!model.canCopy || sandbox.busy)
          .accessibilityIdentifier("file-recovery-save")
        Button("Clear selection") { model.clearSelection() }.disabled(model.busy || model.selectedPaths.isEmpty)
        if model.copying { Button(model.cancelRequested ? "Cancelling…" : "Cancel remaining files") { model.cancel() }.disabled(model.cancelRequested) }
      }
      Text("Choose a folder next. A new private subfolder is created; existing files are never overwritten. Downloaded files are not opened or executed.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary)
    }.recoverySurface()
  }

  private var copyResults: some View {
    VStack(alignment: .leading, spacing: 10) {
      RecoverySectionTitle(title: "Last copy: \(model.savedCount) of \(model.results.count) files saved", subtitle: model.copiedSource)
      if let directory = model.directory {
        Text(directory.path).font(.caption.monospaced()).textSelection(.enabled)
        Button("Show destination in Finder") { NSWorkspace.shared.activateFileViewerSelecting([directory]) }.disabled(model.busy)
      }
      ForEach(model.results) { result in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: result.state == .saved ? "checkmark.circle" : "doc.badge.ellipsis")
            .foregroundStyle(result.state == .saved ? RecoveryTone.standard.color : RecoveryTone.attention.color).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text("\(result.path) — \(result.state.rawValue)").font(.callout)
            if !result.detail.isEmpty { Text(result.detail).font(.caption).foregroundStyle(RecoveryPalette.secondary).textSelection(.enabled) }
          }
        }
      }
      Text("Saved and verified means these selected bytes were written and read back on this Mac. It does not certify all sandbox files or reports were preserved. The original remains untouched.")
        .font(.caption).foregroundStyle(RecoveryPalette.secondary)
    }.recoverySurface()
  }

  private func startReview(_ resource: SandboxRecoveryResource) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      RecoverySectionTitle(title: "Start old environment", subtitle: "Only the machine starts. You return here to browse and save files; no coding or checks are started.")
      Text("Compute charges may resume. Starting does not copy files or prove that earlier task execution stopped. File access is checked afterward and may still be unavailable.").font(.callout)
      Text("Reason for starting").font(.callout.weight(.semibold))
      TextField("For example: retrieve files missing from the saved copy", text: $sandbox.reason, axis: .vertical)
        .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(sandbox.busy)
        .accessibilityIdentifier("file-recovery-start-reason")
      Text("10–4000 characters. This is an audit note, not an instruction to the agent.").font(.caption).foregroundStyle(RecoveryPalette.secondary)
      if sandbox.snapshot?.generation != startGeneration { Text("The task changed. Go back and review the current environment before starting.").font(.callout) }
      if let notice = sandbox.notice { Text(notice).font(.callout) }
      if let error = sandbox.error { RecoveryNotice(title: "Start outcome needs attention", message: error) }
      if sandbox.busy { ProgressView("Checking the original environment…").controlSize(.small) }
      if sandbox.canDiscardRejectedStart {
        Button("Review a new decision after confirmed rejection") { Task { await sandbox.discardRejected(actions.sandboxRecovery) } }
      }
      HStack {
        Button("Back to files") { startResource = nil }.disabled(sandbox.busy)
        Spacer()
        Button("Check recorded status") { Task { await refresh() } }.disabled(sandbox.busy || model.busy)
        Button("Confirm machine start") {
          Task {
            guard sandbox.snapshot?.generation == startGeneration,
              let current = sandbox.snapshot?.resources.first(where: { $0.sandboxId == resource.sandboxId && $0.resourceKey == resource.resourceKey }),
              sandbox.canStart(current) else { return }
            await sandbox.submit(current, action: "start", actions: actions.sandboxRecovery)
            await model.refresh(actions.fileRecovery, includeOriginal: true)
            if sandbox.error == nil && sandbox.pendingStart == nil { startResource = nil; scrollTarget = "file-selection"; scrollRequest += 1 }
          }
        }.buttonStyle(.borderedProminent).disabled(!canConfirmStart(resource) || model.busy)
          .accessibilityIdentifier("file-recovery-confirm-start")
      }
    }.padding(24).frame(width: 600).background(DesktopTheme.canvas)
      .interactiveDismissDisabled(sandbox.busy || model.busy)
  }

  private func canConfirmStart(_ resource: SandboxRecoveryResource) -> Bool {
    guard sandbox.snapshot?.generation == startGeneration,
      let current = sandbox.snapshot?.resources.first(where: { $0.sandboxId == resource.sandboxId && $0.resourceKey == resource.resourceKey }) else { return false }
    return sandbox.canStart(current)
  }

  private func refresh() async {
    if actions.sandboxRecovery.available { await sandbox.refresh(actions.sandboxRecovery) }
    await model.refresh(actions.fileRecovery, includeOriginal: model.selectedSourceID == "original")
  }
  private func chooseDirectory() async -> URL? {
    let panel = NSOpenPanel()
    panel.title = "Save selected recovery files"
    panel.message = "Choose a destination. Autopod creates a new folder and never overwrites existing files."
    panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false; panel.prompt = "Save copy here"
    return await withCheckedContinuation { continuation in
      panel.begin { result in continuation.resume(returning: result == .OK ? panel.url : nil) }
    }
  }
  private func bytes(_ value: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file) }
}
