import AutopodClient
import SwiftUI

// MARK: - Diff model

public struct DiffFile: Identifiable, Sendable {
  public let id: String
  public let path: String
  public let status: DiffFileStatus
  public let hunks: [DiffHunk]
  public var linesAdded: Int
  public var linesRemoved: Int
  public var note: String?
  public var binary: Bool
  public var truncated: Bool
  public var groupLabel: String?

  public init(
    id: String? = nil,
    path: String,
    status: DiffFileStatus,
    hunks: [DiffHunk],
    linesAdded: Int,
    linesRemoved: Int,
    note: String? = nil,
    binary: Bool = false,
    truncated: Bool = false,
    groupLabel: String? = nil
  ) {
    self.id = id ?? "\(groupLabel ?? "diff"):\(path)"
    self.path = path
    self.status = status
    self.hunks = hunks
    self.linesAdded = linesAdded
    self.linesRemoved = linesRemoved
    self.note = note
    self.binary = binary
    self.truncated = truncated
    self.groupLabel = groupLabel
  }
}

public enum DiffFileStatus: String, Sendable {
  case added, modified, deleted
  public var color: Color {
    switch self {
    case .added: .green
    case .modified: .blue
    case .deleted: .red
    }
  }
  public var icon: String {
    switch self {
    case .added: "plus.circle"
    case .modified: "pencil.circle"
    case .deleted: "minus.circle"
    }
  }
}

public struct DiffHunk: Identifiable, Sendable {
  public let id = UUID()
  public let header: String
  public let lines: [DiffLine]
  public init(header: String, lines: [DiffLine]) {
    self.header = header; self.lines = lines
  }
}

public struct DiffLine: Identifiable, Sendable {
  public let id = UUID()
  public let kind: Kind
  public let content: String
  public enum Kind: Sendable { case context, added, removed }
  public init(kind: Kind, content: String) { self.kind = kind; self.content = content }
}

private struct ParsedCommit: Identifiable, Sendable {
  var id: String { commit.sha }
  let commit: DiffApiCommit
  let files: [DiffFile]
}

private enum DiffDisplayMode: String, CaseIterable, Identifiable {
  case files = "Files"
  case commits = "Commits"
  var id: String { rawValue }
}

// MARK: - Diff parser

public enum DiffParser {
  public static func parse(_ raw: String, groupLabel: String? = nil) -> [DiffFile] {
    var files: [DiffFile] = []
    let lines = raw.components(separatedBy: "\n")
    var i = 0

    while i < lines.count {
      let line = lines[i]

      if line.hasPrefix("diff --git") {
        let headerLine = line
        i += 1
        var path = ""
        var status: DiffFileStatus = .modified
        var hunks: [DiffHunk] = []
        var added = 0, removed = 0

        while i < lines.count && !lines[i].hasPrefix("@@") && !lines[i].hasPrefix("diff --git") {
          let l = lines[i]
          if l.hasPrefix("+++ b/") { path = String(l.dropFirst(6)) }
          else if l.hasPrefix("+++ /dev/null") { status = .deleted }
          else if l.hasPrefix("--- /dev/null") { status = .added }
          else if l.hasPrefix("new file") { status = .added }
          else if l.hasPrefix("deleted file") { status = .deleted }
          i += 1
        }

        if path.isEmpty {
          let header = headerLine.replacingOccurrences(of: "diff --git ", with: "")
          if let range = header.range(of: " b/") {
            path = String(header[range.upperBound...])
          }
        }

        while i < lines.count && !lines[i].hasPrefix("diff --git") {
          let l = lines[i]
          if l.hasPrefix("@@") {
            let header = l
            i += 1
            var hunkLines: [DiffLine] = []
            while i < lines.count && !lines[i].hasPrefix("@@") && !lines[i].hasPrefix("diff --git") {
              let hl = lines[i]
              if hl.hasPrefix("+") {
                hunkLines.append(DiffLine(kind: .added, content: String(hl.dropFirst())))
                added += 1
              } else if hl.hasPrefix("-") {
                hunkLines.append(DiffLine(kind: .removed, content: String(hl.dropFirst())))
                removed += 1
              } else {
                let content = hl.hasPrefix(" ") ? String(hl.dropFirst()) : hl
                hunkLines.append(DiffLine(kind: .context, content: content))
              }
              i += 1
            }
            hunks.append(DiffHunk(header: header, lines: hunkLines))
          } else {
            i += 1
          }
        }

        if !path.isEmpty {
          files.append(
            DiffFile(
              path: path,
              status: status,
              hunks: hunks,
              linesAdded: added,
              linesRemoved: removed,
              groupLabel: groupLabel
            )
          )
        }
      } else {
        i += 1
      }
    }

    return files
  }

  public static func parse(_ apiFile: DiffApiFile, groupLabel: String? = nil) -> DiffFile {
    let parsed = parse(apiFile.diff, groupLabel: groupLabel).first
    let status = DiffFileStatus(rawValue: apiFile.status) ?? parsed?.status ?? .modified
    return DiffFile(
      id: "\(groupLabel ?? "diff"):\(apiFile.path)",
      path: apiFile.path,
      status: status,
      hunks: parsed?.hunks ?? [],
      linesAdded: parsed?.linesAdded ?? countLines(apiFile.diff, prefix: "+"),
      linesRemoved: parsed?.linesRemoved ?? countLines(apiFile.diff, prefix: "-"),
      note: apiFile.note,
      binary: apiFile.binary ?? false,
      truncated: apiFile.truncated ?? false,
      groupLabel: groupLabel
    )
  }

  private static func countLines(_ diff: String, prefix: Character) -> Int {
    diff.split(separator: "\n").filter { line in
      line.first == prefix && !line.hasPrefix("\(prefix)\(prefix)\(prefix)")
    }.count
  }
}

// MARK: - Diff tab view

public struct DiffTab: View {
  public let pod: Pod
  public let diffResponse: DiffApiResponse?
  public var onRefresh: (() -> Void)?

  public init(pod: Pod, diffResponse: DiffApiResponse? = nil, onRefresh: (() -> Void)? = nil) {
    self.pod = pod
    self.diffResponse = diffResponse
    self.onRefresh = onRefresh
  }

  @State private var selectedFile: String?
  @State private var mode: DiffDisplayMode = .files
  @State private var canonicalFiles: [DiffFile] = []
  @State private var previewFiles: [DiffFile] = []
  @State private var uncommittedFiles: [DiffFile] = []
  @State private var parsedCommits: [ParsedCommit] = []
  @State private var isParsing = false

  private var allFileModeFiles: [DiffFile] { canonicalFiles + previewFiles }
  private var totalAdded: Int { canonicalFiles.reduce(0) { $0 + $1.linesAdded } }
  private var totalRemoved: Int { canonicalFiles.reduce(0) { $0 + $1.linesRemoved } }

  private var responseIdentity: String {
    guard let diffResponse else { return "nil:\(pod.id)" }
    let commitIds = (diffResponse.commits ?? []).map { commit in
      "\(commit.sha):\(fingerprint(commit.files))"
    }.joined(separator: ",")
    return [
      fingerprint(diffResponse.files),
      fingerprint(diffResponse.previewFiles ?? []),
      fingerprint(diffResponse.uncommittedFiles ?? []),
      commitIds,
    ].joined(separator: "|")
  }

  private func fingerprint(_ files: [DiffApiFile]) -> String {
    var hash: UInt64 = 14_695_981_039_346_656_037

    func mix(_ value: String) {
      for byte in value.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 1_099_511_628_211
      }
      hash ^= 0xff
      hash = hash &* 1_099_511_628_211
    }

    for file in files {
      mix(file.path)
      mix(file.status)
      mix(file.diff)
      mix(file.note ?? "")
      mix(file.binary == true ? "binary" : "text")
      mix(file.truncated == true ? "truncated" : "full")
    }

    return String(hash, radix: 16)
  }

  private var emptyStateSubline: String? {
    switch pod.status {
    case .provisioning:
      "Container is starting..."
    case .running, .awaitingInput, .paused:
      "No tracked or untracked changes visible yet"
    case .validating, .merging, .mergePending, .handoff, .killing:
      "Refreshing diff..."
    case .complete, .failed, .killed:
      "No changes recorded for this pod"
    default:
      nil
    }
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Picker("", selection: $mode) {
          ForEach(DiffDisplayMode.allCases) { item in
            Text(item.rawValue).tag(item)
          }
        }
        .pickerStyle(.segmented)
        .frame(width: 180)

        Spacer()

        if let onRefresh {
          Button {
            onRefresh()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.borderless)
          .controlSize(.small)
          .help("Refresh diff")
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)

      Divider()

      Group {
        if isParsing {
          loadingState
        } else {
          switch mode {
          case .files:
            filesMode
          case .commits:
            commitsMode
          }
        }
      }
    }
    .task(id: responseIdentity) {
      await parseResponse()
    }
    .task(id: pod.status) {
      guard pod.status.isActive, let onRefresh else { return }
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        if Task.isCancelled { break }
        onRefresh()
      }
    }
  }

  private var loadingState: some View {
    VStack(spacing: 10) {
      ProgressView()
      Text("Parsing diff...")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var filesMode: some View {
    Group {
      if allFileModeFiles.isEmpty {
        emptyState(title: "No diff available", subline: emptyStateSubline)
      } else {
        HSplitView {
          fileSidebar
          fileDiffContent(files: allFileModeFiles)
        }
      }
    }
  }

  private var commitsMode: some View {
    let hasCommitContent =
      !parsedCommits.isEmpty || !uncommittedFiles.isEmpty || !previewFiles.isEmpty

    return Group {
      if !hasCommitContent {
        emptyState(
          title: diffResponse?.commitGroupingUnavailableReason == nil
            ? "No commits yet"
            : "Commit groups unavailable",
          subline: diffResponse?.commitGroupingUnavailableReason ?? emptyStateSubline
        )
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            if !uncommittedFiles.isEmpty {
              diffGroupView(
                title: "Uncommitted tracked changes",
                subtitle: "Working tree vs HEAD",
                files: uncommittedFiles
              )
            }

            ForEach(parsedCommits) { item in
              commitGroupView(item)
            }

            if !previewFiles.isEmpty {
              diffGroupView(
                title: "Untracked workspace preview",
                subtitle: "\(previewFiles.count) file\(previewFiles.count == 1 ? "" : "s")",
                files: previewFiles
              )
            }
          }
          .padding(8)
        }
      }
    }
  }

  private var fileSidebar: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text("\(canonicalFiles.count) files")
          .font(.caption.weight(.semibold))
        if !previewFiles.isEmpty {
          Text("+ \(previewFiles.count) preview")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Text("+\(totalAdded)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.green)
        Text("-\(totalRemoved)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.red)
      }
      .padding(10)

      Divider()

      List(selection: $selectedFile) {
        if !canonicalFiles.isEmpty {
          Section("Canonical diff") {
            ForEach(canonicalFiles) { file in fileRow(file) }
          }
        }
        if !previewFiles.isEmpty {
          Section("Untracked preview") {
            ForEach(previewFiles) { file in fileRow(file) }
          }
        }
      }
      .listStyle(.sidebar)
    }
    .frame(minWidth: 220, idealWidth: 320)
  }

  private func fileRow(_ file: DiffFile) -> some View {
    HStack(spacing: 6) {
      Image(systemName: file.status.icon)
        .foregroundStyle(file.status.color)
        .font(.system(size: 10))
      Text(file.path)
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
        .help(file.path)
      Spacer()
      Text("+\(file.linesAdded) -\(file.linesRemoved)")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
    }
    .tag(file.id)
  }

  private func fileDiffContent(files: [DiffFile]) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if let selectedFile,
           let file = files.first(where: { $0.id == selectedFile }) {
          diffFileView(file)
        } else {
          if !canonicalFiles.isEmpty {
            diffGroupView(title: "Canonical diff", subtitle: nil, files: canonicalFiles)
          }
          if !previewFiles.isEmpty {
            diffGroupView(
              title: "Untracked workspace preview",
              subtitle: "\(previewFiles.count) file\(previewFiles.count == 1 ? "" : "s")",
              files: previewFiles
            )
          }
        }
      }
      .padding(8)
    }
  }

  private func commitGroupView(_ item: ParsedCommit) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(item.commit.shortSha)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
          .foregroundStyle(.cyan)
        Text(item.commit.subject)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
        Spacer()
        Text("+\(item.commit.stats.added) -\(item.commit.stats.removed)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.secondary)
      }

      if !item.commit.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text(item.commit.body)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(3)
      }

      ForEach(item.files) { file in
        diffFileView(file)
      }
    }
    .padding(.bottom, 10)
  }

  private func diffGroupView(title: String, subtitle: String?, files: [DiffFile]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(title)
          .font(.caption.weight(.semibold))
        if let subtitle {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, 8)
      .padding(.top, 6)

      ForEach(files) { file in
        diffFileView(file)
      }
    }
  }

  private func diffFileView(_ file: DiffFile) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: file.status.icon)
          .foregroundStyle(file.status.color)
        Text(file.path)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
        if file.truncated {
          Text("truncated")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(nsColor: .controlBackgroundColor))

      if let note = file.note {
        Text(note)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
      } else if file.hunks.isEmpty {
        Text(file.binary ? "Binary file" : "No textual hunks")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
      }

      ForEach(file.hunks) { hunk in
        Text(hunk.header)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.cyan)
          .padding(.horizontal, 8)
          .padding(.vertical, 2)

        ForEach(hunk.lines) { line in
          Text(linePrefix(line.kind) + line.content)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(lineColor(line.kind))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .background(lineBackground(line.kind))
        }
      }

      Divider().padding(.vertical, 4)
    }
  }

  private func emptyState(title: String, subline: String?) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text(title)
        .font(.subheadline)
        .foregroundStyle(.secondary)
      if let subline {
        Text(subline)
          .font(.caption)
          .foregroundStyle(.tertiary)
          .multilineTextAlignment(.center)
      }
      if let onRefresh {
        Button {
          onRefresh()
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func parseResponse() async {
    guard let diffResponse else {
      canonicalFiles = []
      previewFiles = []
      uncommittedFiles = []
      parsedCommits = []
      selectedFile = nil
      return
    }

    isParsing = true
    let result = await Task.detached(priority: .userInitiated) {
      let canonical = diffResponse.files.map {
        DiffParser.parse($0, groupLabel: "canonical")
      }
      let preview = (diffResponse.previewFiles ?? []).map {
        DiffParser.parse($0, groupLabel: "preview")
      }
      let uncommitted = (diffResponse.uncommittedFiles ?? []).map {
        DiffParser.parse($0, groupLabel: "uncommitted")
      }
      let commits = (diffResponse.commits ?? []).map { commit in
        ParsedCommit(
          commit: commit,
          files: commit.files.map {
            DiffParser.parse($0, groupLabel: commit.shortSha)
          }
        )
      }
      return (canonical, preview, uncommitted, commits)
    }.value

    canonicalFiles = result.0
    previewFiles = result.1
    uncommittedFiles = result.2
    parsedCommits = result.3
    let validIds = Set((canonicalFiles + previewFiles).map(\.id))
    if let selectedFile, !validIds.contains(selectedFile) {
      self.selectedFile = nil
    }
    isParsing = false
  }

  private func linePrefix(_ kind: DiffLine.Kind) -> String {
    switch kind {
    case .added: "+ "
    case .removed: "- "
    case .context: "  "
    }
  }

  private func lineColor(_ kind: DiffLine.Kind) -> Color {
    switch kind {
    case .added: .green
    case .removed: .red
    case .context: .primary
    }
  }

  private func lineBackground(_ kind: DiffLine.Kind) -> Color {
    switch kind {
    case .added: .green.opacity(0.06)
    case .removed: .red.opacity(0.06)
    case .context: .clear
    }
  }
}

#Preview("Diff tab") {
  DiffTab(pod: MockData.validated)
}
