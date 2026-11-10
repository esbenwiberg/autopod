import AutopodClient
import Foundation
import Observation

@MainActor @Observable final class FileRecoveryModel {
  struct CopyResult: Identifiable {
    enum State: String { case queued = "Not copied", reading = "Reading", saved = "Saved and verified", failed = "Not saved" }
    var id: String { path }
    let path: String
    var state: State = .queued
    var detail = ""
  }
  let podId: String
  private let scope: String
  private(set) var snapshot: RecoveryFilesSnapshot?
  private(set) var selectedSourceID: String?
  private(set) var selectedPaths: Set<String> = []
  private(set) var busy = false
  private(set) var copying = false
  private(set) var cancelRequested = false
  private(set) var error: String?
  private(set) var invalidated = false
  private(set) var results: [CopyResult] = []
  private(set) var copiedSource = ""
  private(set) var directory: URL?

  init(podId: String, actions: FileRecoveryActions) { self.podId = podId; scope = actions.scope }
  var source: RecoveryFileSource? { snapshot?.sources.first { $0.id == selectedSourceID } }
  var selectedFiles: [RecoveryFileEntry] { source?.files.filter { selectedPaths.contains($0.path) } ?? [] }
  var selectedBytes: Int { selectedFiles.reduce(0) { $0 + $1.size } }
  var canCopy: Bool {
    !busy && !invalidated && source?.status == .available && !selectedPaths.isEmpty && selectedPaths.count <= 100
      && selectedFiles.count == selectedPaths.count && selectedBytes <= (snapshot?.limits.maxSelectionBytes ?? 0)
  }
  var savedCount: Int { results.filter { $0.state == .saved }.count }

  private func current(_ actions: FileRecoveryActions) -> Bool {
    let valid = !invalidated && actions.available && actions.scope == scope && actions.isCurrent()
    if !valid { invalidated = true }
    return valid
  }
  func invalidateObservation() {
    guard !busy else { return }
    snapshot = nil; selectedPaths = []; error = "The task changed. Refresh files before selecting a copy."
  }
  func select(_ id: String) {
    guard !busy, snapshot?.sources.contains(where: { $0.id == id && $0.status == .available }) == true else { return }
    selectedSourceID = id; selectedPaths = []
  }
  func toggle(_ file: RecoveryFileEntry) {
    guard !busy, source?.status == .available, source?.files.contains(file) == true else { return }
    if selectedPaths.contains(file.path) { selectedPaths.remove(file.path) }
    else if selectedPaths.count < 100 && selectedBytes + file.size <= (snapshot?.limits.maxSelectionBytes ?? 0) { selectedPaths.insert(file.path) }
  }
  func clearSelection() { guard !busy else { return }; selectedPaths = [] }
  func cancel() { if copying { cancelRequested = true } }

  func refresh(_ actions: FileRecoveryActions, includeOriginal: Bool = false) async {
    guard !busy else { return }
    snapshot = nil; selectedPaths = []; error = nil
    guard current(actions) else { error = "File browsing is unavailable on this connection. No environment was started."; return }
    busy = true
    defer { busy = false }
    do {
      let value = try await actions.load(podId, includeOriginal)
      guard current(actions), !Task.isCancelled else { throw URLError(.cancelled) }
      try value.validate(podId: podId)
      snapshot = value
      if includeOriginal {
        selectedSourceID = "original"
        if source?.status != .available { error = "Original files are unavailable. Saved copies remain separate; choose one explicitly if needed." }
      } else if let selectedSourceID {
        if value.sources.first(where: { $0.id == selectedSourceID })?.status != .available {
          error = "The selected file location is unavailable. No different source was selected; refresh or choose another location explicitly."
        }
      } else {
        selectedSourceID = value.sources.first { $0.kind == .saved && $0.status == .available && !$0.files.isEmpty }?.id
          ?? value.sources.first { $0.kind == .saved && $0.status == .available }?.id
      }
    } catch {
      self.error = "Could not browse recovery files: \(error.localizedDescription). No environment was started and no other source was substituted."
    }
  }

  func copy(_ actions: FileRecoveryActions, chooseDirectory: @MainActor () async -> URL?) async {
    guard canCopy, current(actions), let snapshot, let source else { return }
    let files = selectedFiles
    busy = true; copying = true; cancelRequested = false; error = nil
    defer { busy = false; copying = false }
    // A cancelled destination picker must not erase the previous copy receipt.
    guard let destination = await chooseDirectory() else { return }
    guard current(actions), !cancelRequested, !Task.isCancelled else { error = "Copy cancelled before any file was saved."; return }
    copiedSource = "\(source.label)\(source.sandboxId.map { " · " + $0 } ?? "") · task state \(snapshot.generation)"
    results = files.map { CopyResult(path: $0.path) }; directory = nil
    do {
      let writer = try RecoveryFileWriter(parent: destination)
      directory = writer.directory
      for (index, file) in files.enumerated() {
        guard current(actions), !cancelRequested, !Task.isCancelled else {
          error = current(actions) ? "Copy cancelled. Files already saved are kept; remaining files were not copied."
            : "Connection changed. Files already saved are kept; no further files were copied."
          break
        }
        results[index].state = .reading
        do {
          let selection = RecoveryFileSelection(source: source, generation: snapshot.generation, file: file)
          let response = try await actions.read(podId, selection)
          guard current(actions), !cancelRequested, !Task.isCancelled else { throw URLError(.cancelled) }
          guard response.path == file.path, response.encoding == "base64", response.size == file.size,
            response.content.utf8.count <= 7 * 1024 * 1024,
            let bytes = Data(base64Encoded: response.content), bytes.count == response.size,
            bytes.base64EncodedString() == response.content, RecoveryFileWriter.hash(bytes) == response.sha256 else {
            throw URLError(.badServerResponse)
          }
          try writer.write(bytes, relative: file.path, sha256: response.sha256)
          results[index].state = .saved
          results[index].detail = "\(bytes.count) bytes · SHA-256 \(response.sha256)"
        } catch {
          results[index].state = .failed
          results[index].detail = error.localizedDescription
          self.error = "Some selected files were not copied. Review the individual results; nothing was deleted."
        }
      }
    } catch { self.error = "Could not save the selected copy: \(error.localizedDescription). Nothing was deleted." }
  }
}
