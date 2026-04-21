import AutopodClient
import MarkdownUI
import SwiftUI

/// Markdown file viewer — browse and render .md files from a pod's worktree.
public struct MarkdownTab: View {
  public let pod: Pod
  public var loadFiles: ((String) async throws -> [SessionFileEntry])?
  public var loadContent: ((String, String) async throws -> SessionFileContent)?

  public init(
    pod: Pod,
    loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
    loadContent: ((String, String) async throws -> SessionFileContent)? = nil
  ) {
    self.pod = pod
    self.loadFiles = loadFiles
    self.loadContent = loadContent
  }

  @State private var files: [SessionFileEntry] = []
  @State private var filter: String = ""
  @State private var selectedPath: String?
  @State private var content: String = ""
  @State private var isLoadingList = false
  @State private var isLoadingContent = false
  @State private var errorMessage: String?

  private var filteredFiles: [SessionFileEntry] {
    guard !filter.isEmpty else { return files }
    let needle = filter.lowercased()
    return files.filter { $0.path.lowercased().contains(needle) }
  }

  public var body: some View {
    HSplitView {
      fileList
        .frame(minWidth: 220, idealWidth: 260, maxWidth: 360)

      renderedPane
    }
    .task(id: pod.id) {
      await refreshFiles()
    }
    .task(id: "\(pod.id)-\(pod.status.rawValue)") {
      // Auto-refresh while the agent is active: files appear as the agent writes them,
      // and the selected file re-renders without a manual reload.
      guard pod.status == .running else { return }
      while !Task.isCancelled {
        do {
          try await Task.sleep(nanoseconds: 5_000_000_000)
        } catch {
          return
        }
        guard pod.status == .running else { return }
        await refreshFiles(silent: true)
        if let sel = selectedPath {
          await silentlyReloadSelected(sel)
        }
      }
    }
  }

  // MARK: - File list

  private var fileList: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
        TextField("Filter files…", text: $filter)
          .textFieldStyle(.plain)
          .font(.system(.caption))
        Button {
          Task { await refreshFiles() }
        } label: {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 11))
        }
        .buttonStyle(.plain)
        .help("Reload file list")
      }
      .padding(10)

      Divider()

      if isLoadingList && files.isEmpty {
        ProgressView()
          .controlSize(.small)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if filteredFiles.isEmpty {
        emptyFileList
      } else {
        List(filteredFiles, selection: $selectedPath) { file in
          HStack(spacing: 6) {
            Image(systemName: "doc.richtext")
              .foregroundStyle(.blue)
              .font(.system(size: 10))
            Text(file.path)
              .font(.system(.caption, design: .monospaced))
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer()
          }
          .tag(file.path)
        }
        .listStyle(.sidebar)
      }
    }
    .onChange(of: selectedPath) { _, path in
      if let path { Task { await loadSelected(path) } }
    }
  }

  private var emptyFileList: some View {
    VStack(spacing: 8) {
      Image(systemName: "doc.richtext")
        .font(.system(size: 24))
        .foregroundStyle(.tertiary)
      Text(files.isEmpty ? "No markdown files" : "No matches")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Rendered pane

  @ViewBuilder
  private var renderedPane: some View {
    if let err = errorMessage {
      errorView(err)
    } else if selectedPath == nil {
      placeholder
    } else if isLoadingContent {
      ProgressView()
        .controlSize(.small)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ScrollView {
        Markdown(content)
          .markdownTheme(.autopod)
          .textSelection(.enabled)
          .padding(20)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private var placeholder: some View {
    VStack(spacing: 10) {
      Image(systemName: "doc.richtext")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("Select a file to view")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      if !files.isEmpty {
        Text("\(files.count) markdown file\(files.count == 1 ? "" : "s") in worktree")
          .font(.caption)
          .foregroundStyle(.tertiary)
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
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Loading

  private func refreshFiles(silent: Bool = false) async {
    guard let loadFiles else { return }
    if !silent {
      isLoadingList = true
      errorMessage = nil
    }
    defer { if !silent { isLoadingList = false } }
    do {
      files = try await loadFiles(pod.id)
      // Drop selection if the file is gone
      if let sel = selectedPath, !files.contains(where: { $0.path == sel }) {
        selectedPath = nil
        content = ""
      }
    } catch {
      if !silent {
        errorMessage = "Failed to load file list: \(error.localizedDescription)"
      }
    }
  }

  private func loadSelected(_ path: String) async {
    guard let loadContent else { return }
    isLoadingContent = true
    errorMessage = nil
    defer { isLoadingContent = false }
    do {
      let result = try await loadContent(pod.id, path)
      content = result.content
    } catch {
      errorMessage = "Failed to load \(path): \(error.localizedDescription)"
      content = ""
    }
  }

  /// Background refresh of the currently-selected file. Preserves scroll by
  /// only assigning content when the string actually differs, and swallows
  /// transient errors so the rendered pane isn't flipped to the error state.
  private func silentlyReloadSelected(_ path: String) async {
    guard let loadContent else { return }
    do {
      let result = try await loadContent(pod.id, path)
      if result.content != content {
        content = result.content
      }
    } catch {
      // Keep last-known content on transient failures.
    }
  }
}

#Preview("Markdown tab — empty") {
  MarkdownTab(pod: MockData.running)
    .frame(width: 800, height: 500)
}
