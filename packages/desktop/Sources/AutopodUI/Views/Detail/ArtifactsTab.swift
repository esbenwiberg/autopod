import AppKit
import AutopodClient
import SwiftUI

/// Browse generated artifacts (HTML reports, plans, JSON, logs, etc.) from a
/// pod's worktree. Workspace pods write to /workspace which only syncs to the
/// host at completion — the daemon's files endpoint reads the live container
/// so this works mid-run too.
///
/// Click a row → fetch via existing /files/content → write to a per-pod cache
/// dir → hand to `NSWorkspace.shared.open()` so macOS routes to Safari (HTML),
/// TextEdit (txt), etc.
public struct ArtifactsTab: View {
  public let pod: Pod
  public var loadArtifacts: ((String) async throws -> [SessionFileEntry])?
  public var loadContent: ((String, String) async throws -> SessionFileContent)?

  public init(
    pod: Pod,
    loadArtifacts: ((String) async throws -> [SessionFileEntry])? = nil,
    loadContent: ((String, String) async throws -> SessionFileContent)? = nil
  ) {
    self.pod = pod
    self.loadArtifacts = loadArtifacts
    self.loadContent = loadContent
  }

  @State private var files: [SessionFileEntry] = []
  @State private var isLoadingList = false
  @State private var listError: String?
  @State private var openError: String?
  @State private var openingPath: String?
  @State private var showAllFiles = false

  private var filteredFiles: [SessionFileEntry] {
    let pivot = (pod.runningAt ?? pod.startedAt).timeIntervalSince1970 * 1000
    let filtered = showAllFiles ? files : files.filter { $0.modified >= pivot }
    return filtered.sorted { $0.modified > $1.modified }
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      body_
    }
    .task(id: pod.id) {
      await refresh()
    }
    .task(id: "\(pod.id)-\(pod.status.rawValue)") {
      await refresh(silent: true)
      // Poll while the agent is active so newly-written files appear without
      // a manual reload — same cadence as MarkdownTab.
      guard pod.status == .running else { return }
      while !Task.isCancelled {
        do {
          try await Task.sleep(nanoseconds: 5_000_000_000)
        } catch {
          return
        }
        guard pod.status == .running else { return }
        await refresh(silent: true)
      }
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(spacing: 8) {
      Text("\(filteredFiles.count) artifact\(filteredFiles.count == 1 ? "" : "s")")
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer()
      Toggle(isOn: $showAllFiles) {
        Text("Show all files")
          .font(.caption)
      }
      .toggleStyle(.checkbox)
      .help("Disable the modified-since-agent-started filter")
      Button {
        Task { await refresh() }
      } label: {
        Image(systemName: "arrow.clockwise")
          .font(.system(size: 11))
      }
      .buttonStyle(.plain)
      .help("Reload artifact list")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  // MARK: - Body

  @ViewBuilder
  private var body_: some View {
    if let err = listError, files.isEmpty {
      errorView(err)
    } else if isLoadingList && files.isEmpty {
      ProgressView()
        .controlSize(.small)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if filteredFiles.isEmpty {
      emptyView
    } else {
      fileList
    }
  }

  private var fileList: some View {
    ScrollView {
      LazyVStack(spacing: 0) {
        if let err = openError {
          openErrorBanner(err)
        }
        ForEach(filteredFiles) { file in
          fileRow(file)
          Divider()
        }
      }
    }
  }

  private func fileRow(_ file: SessionFileEntry) -> some View {
    let basename = (file.path as NSString).lastPathComponent
    let isOpening = openingPath == file.path

    return Button {
      Task { await openFile(file) }
    } label: {
      HStack(spacing: 10) {
        Image(systemName: iconName(for: file.path))
          .foregroundStyle(.blue)
          .font(.system(size: 14))
          .frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          Text(basename)
            .font(.system(.body))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.middle)
          HStack(spacing: 6) {
            Text(file.path)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.tertiary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
          Text(relativeTime(file.modified))
            .font(.caption)
            .foregroundStyle(.secondary)
          Text(formatSize(file.size))
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        if isOpening {
          ProgressView()
            .controlSize(.small)
            .frame(width: 16)
        } else {
          Image(systemName: "arrow.up.forward.app")
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .frame(width: 16)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(isOpening)
    .help("Open in default app")
  }

  private var emptyView: some View {
    VStack(spacing: 10) {
      Image(systemName: "doc.on.doc")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("No artifacts yet")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      Text("Files generated during this pod will appear here automatically")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
      if !showAllFiles && !files.isEmpty {
        Button("Show all files") {
          showAllFiles = true
        }
        .buttonStyle(.link)
        .controlSize(.small)
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func errorView(_ message: String) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 24))
        .foregroundStyle(.orange)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 20)
      Button("Retry") {
        Task { await refresh() }
      }
      .controlSize(.small)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func openErrorBanner(_ message: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer()
      Button {
        openError = nil
      } label: {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(Color.orange.opacity(0.12))
  }

  // MARK: - Actions

  private func refresh(silent: Bool = false) async {
    guard let loadArtifacts else { return }
    if !silent {
      isLoadingList = true
      listError = nil
    }
    defer { if !silent { isLoadingList = false } }
    do {
      files = try await loadArtifacts(pod.id)
    } catch {
      if !silent {
        listError = "Failed to load artifacts: \(error.localizedDescription)"
      }
    }
  }

  /// Fetch the file's content via the existing /files/content endpoint, write
  /// it to a per-pod cache dir, and hand off to `NSWorkspace.shared.open()`.
  /// macOS routes to Safari for `.html`, TextEdit for `.txt`, etc.
  private func openFile(_ file: SessionFileEntry) async {
    guard let loadContent else { return }
    openingPath = file.path
    openError = nil
    defer { openingPath = nil }

    do {
      let result = try await loadContent(pod.id, file.path)
      let url = try writeToCache(podId: pod.id, relativePath: file.path, payload: result)
      let opened = NSWorkspace.shared.open(url)
      if !opened {
        openError = "macOS couldn't open \((file.path as NSString).lastPathComponent) — no default app for this type."
      }
    } catch {
      openError = "Failed to open \(file.path): \(error.localizedDescription)"
    }
  }

  /// Write artifact content under ~/Library/Caches/Autopod/<podId>/. The daemon
  /// returns base64 for binary types (png/pdf/jpg/…) — decode to Data; otherwise
  /// write the utf-8 string. Cleanup is best-effort; we never block the
  /// user-visible action on housekeeping.
  private func writeToCache(
    podId: String, relativePath: String, payload: SessionFileContent
  ) throws -> URL {
    let basename = (relativePath as NSString).lastPathComponent
    let caches = try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    )
    let podDir = caches
      .appendingPathComponent("Autopod", isDirectory: true)
      .appendingPathComponent(podId, isDirectory: true)
    try FileManager.default.createDirectory(at: podDir, withIntermediateDirectories: true)
    let fileURL = podDir.appendingPathComponent(basename)

    if payload.encoding == "base64" {
      guard let data = Data(base64Encoded: payload.content) else {
        throw NSError(
          domain: "Autopod.ArtifactsTab", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Server returned malformed base64"]
        )
      }
      try data.write(to: fileURL, options: .atomic)
    } else {
      try payload.content.write(to: fileURL, atomically: true, encoding: .utf8)
    }
    return fileURL
  }

  // MARK: - Formatting

  private func relativeTime(_ epochMs: Double) -> String {
    let date = Date(timeIntervalSince1970: epochMs / 1000)
    return _artifactsRelFmt.localizedString(for: date, relativeTo: Date())
  }

  private func formatSize(_ bytes: Int) -> String {
    _artifactsByteFmt.string(fromByteCount: Int64(bytes))
  }

  private func iconName(for path: String) -> String {
    let ext = (path as NSString).pathExtension.lowercased()
    switch ext {
    case "html", "htm": return "globe"
    case "md": return "doc.richtext"
    case "json": return "curlybraces"
    case "csv": return "tablecells"
    case "log", "txt": return "doc.text"
    case "svg", "png", "jpg", "jpeg", "gif", "webp": return "photo"
    case "pdf": return "doc.richtext.fill"
    default: return "doc"
    }
  }
}

nonisolated(unsafe) private let _artifactsRelFmt: RelativeDateTimeFormatter = {
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .short
  return f
}()

nonisolated(unsafe) private let _artifactsByteFmt: ByteCountFormatter = {
  let f = ByteCountFormatter()
  f.allowedUnits = [.useKB, .useMB, .useGB]
  f.countStyle = .file
  return f
}()

#Preview("Artifacts tab — empty") {
  ArtifactsTab(pod: MockData.running)
    .frame(width: 800, height: 500)
}
