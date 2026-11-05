import AppKit
import AutopodClient
import Darwin
import SwiftUI

/// Never renders active attachment content. Local bytes are frozen before preview.
internal struct LaunchAttachmentsEditor: View {
  @Binding var files: [InputAttachment]
  @Binding var work: [String: ConfigurationJSON]?
  var available: Bool
  @State private var error: String?
  private var manifestFiles: [ConfigurationJSON] { work?["inputBundle"]?["files"]?.array ?? [] }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Reference attachments").font(.headline)
      Text("Wireframes, HTML and images · reference only, not added to source. HTML rendering requires an isolated renderer; visual comparison needs captured application views.")
        .font(.caption).foregroundStyle(.secondary)
      HStack {
        Button("Add files or folder…") { pick() }
        Button("Paste image") { paste() }
      }.disabled(!available)
      if !available { Text("This daemon does not support reference uploads.").font(.caption).foregroundStyle(.secondary) }
      if files.isEmpty {
        ForEach(Array(manifestFiles.enumerated()), id: \.offset) { _, file in Text(file["path"]?.string ?? "Reference").font(.caption.monospaced()) }
        if !manifestFiles.isEmpty { Button("Clear references") { clear() } }
      } else {
        ForEach(files) { file in
          HStack {
            Image(systemName: file.file.mediaType.hasPrefix("image/") ? "photo" : "doc")
            Text(file.file.path).font(.caption.monospaced()).lineLimit(2)
            Spacer()
            Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes.count), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
            Button { files.removeAll { $0.id == file.id }; unseal() } label: { Image(systemName: "xmark.circle") }.buttonStyle(.plain).accessibilityLabel("Remove \(file.file.path)")
          }
        }
      }
      if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
    }
    .padding(12).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
    .dropDestination(for: URL.self) { urls, _ in
      guard available else { return false }; add(urls); return true
    }
    .accessibilityIdentifier("launch-reference-attachments")
  }
  private func unseal() { if work == nil { work = [:] }; work?["inputBundle"] = .null }
  private func clear() { files = []; unseal() }
  private func pick() {
    let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
    panel.prompt = "Attach references"
    if panel.runModal() == .OK { add(panel.urls) }
  }
  private func add(_ urls: [URL]) {
    do {
      let additions = try LocalReferenceCollector.collect(urls)
      let candidate = files + additions
      try InputAttachment.validate(candidate)
      files = candidate; unseal(); error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func paste() {
    do {
      guard let image = NSImage(pasteboard: .general), let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff), bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0,
        Double(bitmap.pixelsWide) * Double(bitmap.pixelsHigh) <= 40_000_000,
        let bytes = bitmap.representation(using: .png, properties: [:]) else { throw DaemonError.badRequest("No supported image on the clipboard") }
      let candidate = files + [try InputAttachment(path: "pasted-\(UUID().uuidString.lowercased()).png", bytes: bytes)]
      try InputAttachment.validate(candidate); files = candidate; unseal(); error = nil
    } catch { self.error = error.localizedDescription }
  }
}

internal enum LocalReferenceCollector {
  static func collect(_ urls: [URL]) throws -> [InputAttachment] {
    var result: [InputAttachment] = []
    let manager = FileManager.default
    var entries = 0
    func append(_ url: URL, name: String, root: String) throws {
      guard try physicalPath(url).hasPrefix(root + "/") else { throw DaemonError.badRequest("Reference escapes the selected folder") }
      guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw DaemonError.badRequest("Only regular reference files are supported") }
      let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      guard fd >= 0 else { throw DaemonError.badRequest("Cannot open attachment without following symlinks") }
      let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
      defer { try? handle.close() }
      var info = stat()
      guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= 10 * 1024 * 1024,
        result.count < 50 else { throw DaemonError.badRequest("References require regular files up to 10 MiB, at most 50 files") }
      let bytes = try handle.read(upToCount: 10 * 1024 * 1024 + 1) ?? Data()
      guard bytes.count == info.st_size else { throw DaemonError.badRequest("Reference changed while reading") }
      result.append(try InputAttachment(path: name, bytes: bytes)); try InputAttachment.validate(result)
    }
    for selected in urls {
      let url = selected.standardizedFileURL
      let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
      guard values.isSymbolicLink != true else { throw DaemonError.badRequest("Reference symlinks are not allowed") }
      if values.isDirectory == true {
        let rootPath = try physicalPath(url)
        let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { throw DaemonError.badRequest("Cannot enumerate reference folder") }
        for case let file as URL in enumerator {
          entries += 1; guard entries <= 2000 else { throw DaemonError.badRequest("Reference folder exceeds 2000 entries") }
          let values = try file.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
          guard values.isSymbolicLink != true else { throw DaemonError.badRequest("Reference symlinks are not allowed") }
          if values.isDirectory == true {
            if ["node_modules", "dist", "build", "coverage", "vendor"].contains(file.lastPathComponent) { enumerator.skipDescendants() }
          } else {
            let actual = try physicalPath(file)
            guard actual.hasPrefix(rootPath + "/") else { throw DaemonError.badRequest("Reference escapes the selected folder") }
            let relative = String(actual.dropFirst(rootPath.count + 1))
            try append(file, name: root.lastPathComponent + "/" + relative, root: rootPath)
          }
        }
      } else { try append(url, name: url.lastPathComponent, root: physicalPath(url.deletingLastPathComponent())) }
    }
    return result.sorted { $0.file.path < $1.file.path }
  }
  private static func physicalPath(_ url: URL) throws -> String {
    guard let resolved = realpath(url.path, nil) else { throw DaemonError.badRequest("Cannot resolve reference path") }
    defer { free(resolved) }
    return String(cString: resolved)
  }
}
