import SwiftUI

// MARK: - Diff model

public struct DiffFile: Identifiable, Sendable {
  public var id: String { path }
  public let path: String
  public let status: DiffFileStatus
  public let hunks: [DiffHunk]
  public var linesAdded: Int
  public var linesRemoved: Int

  public init(path: String, status: DiffFileStatus, hunks: [DiffHunk], linesAdded: Int, linesRemoved: Int) {
    self.path = path; self.status = status; self.hunks = hunks
    self.linesAdded = linesAdded; self.linesRemoved = linesRemoved
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

// MARK: - Diff parser

public enum DiffParser {
  public static func parse(_ raw: String) -> [DiffFile] {
    var files: [DiffFile] = []
    let lines = raw.components(separatedBy: "\n")
    var i = 0

    while i < lines.count {
      let line = lines[i]

      // Start of a new file diff
      if line.hasPrefix("diff --git") {
        i += 1
        var path = ""
        var status: DiffFileStatus = .modified
        var hunks: [DiffHunk] = []
        var added = 0, removed = 0

        // Parse header lines
        while i < lines.count && !lines[i].hasPrefix("@@") && !lines[i].hasPrefix("diff --git") {
          let l = lines[i]
          if l.hasPrefix("+++ b/") { path = String(l.dropFirst(6)) }
          else if l.hasPrefix("new file") { status = .added }
          else if l.hasPrefix("deleted file") { status = .deleted }
          i += 1
        }

        // Parse hunks
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
          files.append(DiffFile(path: path, status: status, hunks: hunks, linesAdded: added, linesRemoved: removed))
        }
      } else {
        i += 1
      }
    }

    return files
  }
}

// MARK: - Diff tab view

public struct DiffTab: View {
  public let session: Session
  public let diffString: String?

  public init(session: Session, diffString: String? = nil) {
    self.session = session
    self.diffString = diffString
  }

  @State private var selectedFile: String?

  private var files: [DiffFile] {
    guard let raw = diffString else { return [] }
    return DiffParser.parse(raw)
  }

  private var totalAdded: Int { files.reduce(0) { $0 + $1.linesAdded } }
  private var totalRemoved: Int { files.reduce(0) { $0 + $1.linesRemoved } }

  public var body: some View {
    if files.isEmpty {
      VStack(spacing: 10) {
        Image(systemName: "doc.text.magnifyingglass")
          .font(.system(size: 32))
          .foregroundStyle(.tertiary)
        Text("No diff available")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        if session.status.isActive {
          Text("Diff will be available after validation")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      HSplitView {
        // File tree
        VStack(alignment: .leading, spacing: 0) {
          // Stats header
          HStack(spacing: 8) {
            Text("\(files.count) files")
              .font(.caption.weight(.semibold))
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

          List(files, selection: $selectedFile) { file in
            HStack(spacing: 6) {
              Image(systemName: file.status.icon)
                .foregroundStyle(file.status.color)
                .font(.system(size: 10))
              Text(file.path)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
              Spacer()
              Text("+\(file.linesAdded) -\(file.linesRemoved)")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
            }
            .tag(file.path)
          }
          .listStyle(.sidebar)
        }
        .frame(minWidth: 200, idealWidth: 220, maxWidth: 300)

        // Diff content
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            let displayFiles = selectedFile.flatMap { sel in files.filter { $0.path == sel } } ?? files
            ForEach(displayFiles) { file in
              diffFileView(file)
            }
          }
          .padding(8)
        }
      }
    }
  }

  private func diffFileView(_ file: DiffFile) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      // File header
      HStack(spacing: 6) {
        Image(systemName: file.status.icon)
          .foregroundStyle(file.status.color)
        Text(file.path)
          .font(.system(.caption, design: .monospaced).weight(.semibold))
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(nsColor: .controlBackgroundColor))

      // Hunks
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
  DiffTab(session: MockData.validated, diffString: """
  diff --git a/src/auth/google.ts b/src/auth/google.ts
  new file mode 100644
  --- /dev/null
  +++ b/src/auth/google.ts
  @@ -0,0 +1,15 @@
  +import { OAuth2Client } from 'google-auth-library';
  +
  +export function createGoogleClient() {
  +  return new OAuth2Client({
  +    clientId: process.env.GOOGLE_CLIENT_ID,
  +    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  +  });
  +}
  diff --git a/src/routes/auth.ts b/src/routes/auth.ts
  --- a/src/routes/auth.ts
  +++ b/src/routes/auth.ts
  @@ -1,5 +1,8 @@
   import express from 'express';
  +import { createGoogleClient } from '../auth/google';

   const router = express.Router();
  +const google = createGoogleClient();

  -router.get('/login', (req, res) => {
  +router.get('/login', async (req, res) => {
  +  const url = google.generateAuthUrl({ scope: ['profile', 'email'] });
  +  res.redirect(url);
   });
  """)
  .frame(width: 700, height: 500)
}
