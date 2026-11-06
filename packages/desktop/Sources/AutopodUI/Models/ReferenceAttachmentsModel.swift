import AutopodClient
import Foundation
import Observation

/// Scoped to one pod and daemon connection by ReferenceAttachmentsCard's identity.
@MainActor @Observable
final class ReferenceAttachmentsModel {
  private(set) var bundle: InputBundleReference?
  private(set) var isLoading = true
  private(set) var error: String?
  private(set) var bytes: [Int: Data] = [:]
  private(set) var fileErrors: [Int: String] = [:]
  private(set) var loadingFiles: Set<Int> = []
  private var generation = UUID()
  @ObservationIgnored private var downloads: [Int: (id: UUID, task: Task<Data, Error>)] = [:]
  private let actions: LaunchConfigurationActions

  init(actions: LaunchConfigurationActions) { self.actions = actions }

  func load(podId: String) async {
    let owner = UUID()
    generation = owner
    for download in downloads.values { download.task.cancel() }
    downloads = [:]
    bundle = nil; bytes = [:]; fileErrors = [:]; loadingFiles = []
    isLoading = true; error = nil
    defer { if generation == owner { isLoading = false } }
    do {
      let launch = try await actions.readLaunch(podId)
      try Task.checkCancellation()
      guard generation == owner else { return }
      bundle = try launch.referenceInputBundle()
    } catch {
      guard generation == owner, !Task.isCancelled else { return }
      self.error = error.localizedDescription
    }
  }

  func loadFile(_ index: Int) async {
    guard let bundle, bundle.files.indices.contains(index), bytes[index] == nil else { return }
    let owner = generation
    let download: (id: UUID, task: Task<Data, Error>)
    if let existing = downloads[index] {
      download = existing
    } else {
      let read = actions.readInputFile
      download = (UUID(), Task {
        try Task.checkCancellation()
        return try await read(bundle, index)
      })
      downloads[index] = download
      loadingFiles.insert(index); fileErrors[index] = nil
    }
    // A closing sheet cancels its waiter, not the shared request. A reopened
    // sheet can await the same bounded read rather than being stranded loading.
    defer {
      if generation == owner, downloads[index]?.id == download.id {
        downloads[index] = nil
        loadingFiles.remove(index)
      }
    }
    do {
      let data = try await download.task.value
      try Task.checkCancellation()
      guard generation == owner else { return }
      bytes[index] = data
    } catch {
      guard generation == owner, !Task.isCancelled else { return }
      fileErrors[index] = error.localizedDescription
    }
  }
}

extension InputFileManifest {
  /// Do not send SVG, HTML or other active content to an image/WebView loader.
  var hasRasterPreview: Bool {
    ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mediaType)
  }

  var hasTextPreview: Bool {
    mediaType.hasPrefix("text/") || ["application/json", "application/xml", "image/svg+xml"].contains(mediaType)
  }

  var formattedSize: String { ByteCountFormatter.string(fromByteCount: Int64(byteLength), countStyle: .file) }
}
