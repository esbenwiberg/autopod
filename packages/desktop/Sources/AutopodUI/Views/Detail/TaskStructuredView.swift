import MarkdownUI
import SwiftUI

struct TaskStructuredView: View {
    let markdown: String

    @State private var showRawMarkdown = false

    private var document: TaskMarkdownDocument {
        TaskMarkdownParser.parse(markdown)
    }

    var body: some View {
        if document.usesStructuredCards, !document.sections.isEmpty {
            if showRawMarkdown {
                rawTaskCard(showModeToggle: true)
            } else {
                structuredCards
            }
        } else {
            rawTaskCard(showModeToggle: false)
        }
    }

    private var structuredCards: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let primary = primarySection {
                taskSectionCard(primary, isProminent: true, showModeToggle: true)
            }

            ForEach(Array(sectionRows.enumerated()), id: \.offset) { _, row in
                sectionRow(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var primarySection: TaskMarkdownSection? {
        document.sections.first { $0.kind == .task } ?? document.sections.first
    }

    private var detailSections: [TaskMarkdownSection] {
        guard let primarySection else { return document.sections }
        return document.sections.filter { $0.id != primarySection.id }
    }

    private var sectionRows: [[TaskMarkdownSection]] {
        var rows: [[TaskMarkdownSection]] = []
        var pendingCompact: [TaskMarkdownSection] = []

        func flushCompactSections() {
            guard !pendingCompact.isEmpty else { return }
            rows.append(pendingCompact)
            pendingCompact = []
        }

        for section in detailSections {
            if prefersWideCard(section) {
                flushCompactSections()
                rows.append([section])
            } else {
                pendingCompact.append(section)
                if pendingCompact.count == 2 {
                    flushCompactSections()
                }
            }
        }

        flushCompactSections()
        return rows
    }

    @ViewBuilder
    private func sectionRow(_ row: [TaskMarkdownSection]) -> some View {
        if row.count == 1, let section = row.first {
            taskSectionCard(section, isProminent: false, showModeToggle: false)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(row) { section in
                        taskSectionCard(section, isProminent: false, showModeToggle: false)
                            .frame(minWidth: 260, maxWidth: .infinity, alignment: .topLeading)
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(row) { section in
                        taskSectionCard(section, isProminent: false, showModeToggle: false)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            }
        }
    }

    private func taskSectionCard(
        _ section: TaskMarkdownSection,
        isProminent: Bool,
        showModeToggle: Bool
    ) -> some View {
        let style = TaskSectionStyle(section: section)
        let background = isProminent
            ? Color(nsColor: .windowBackgroundColor)
            : Color(nsColor: .controlBackgroundColor)

        return HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(style.accent.opacity(isProminent ? 0.58 : 0.46))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))

            VStack(alignment: .leading, spacing: isProminent ? 8 : 7) {
                HStack(spacing: 5) {
                    Image(systemName: style.icon)
                        .font(.system(size: isProminent ? 11 : 10))
                        .foregroundStyle(style.accent)
                        .frame(width: 15)
                    Text(style.label)
                        .font(.system(.caption, design: .default).weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.3)
                    Spacer(minLength: 8)
                    if showModeToggle {
                        modeToggleButton
                    }
                }

                if isProminent {
                    Text(section.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                }

                Markdown(section.body)
                    .markdownTheme(.autopod)
                    .font(isProminent ? .subheadline : .callout)
                    .foregroundStyle(isProminent ? .primary : .secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, isProminent ? 12 : 11)
            .padding(.vertical, isProminent ? 10 : 11)
        }
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
        )
    }

    private func rawTaskCard(showModeToggle: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.5))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "text.quote")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Text("Task")
                        .font(.system(.caption, design: .default).weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.3)
                    Spacer(minLength: 8)
                    if showModeToggle {
                        modeToggleButton
                    }
                }
                Markdown(markdown)
                    .markdownTheme(.autopod)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
        )
    }

    private var modeToggleButton: some View {
        Button {
            showRawMarkdown.toggle()
        } label: {
            Image(systemName: showRawMarkdown ? "square.grid.2x2" : "doc.text")
                .font(.system(size: 11))
        }
        .buttonStyle(.plain)
        .help(showRawMarkdown ? "Show cards" : "Show raw markdown")
        .accessibilityLabel(showRawMarkdown ? "Show task cards" : "Show raw task markdown")
    }

    private func prefersWideCard(_ section: TaskMarkdownSection) -> Bool {
        switch section.kind {
        case .constraints, .tests:
            return true
        default:
            return section.body.count > 520
        }
    }
}

private struct TaskSectionStyle {
    let label: String
    let icon: String
    let accent: Color

    init(section: TaskMarkdownSection) {
        switch section.kind {
        case .task:
            self.label = "Task"
            self.icon = "text.quote"
            self.accent = .accentColor
        case .dtos:
            self.label = "DTOs"
            self.icon = "square.stack.3d.up"
            self.accent = .blue
        case .service:
            self.label = "Service"
            self.icon = "wrench.and.screwdriver"
            self.accent = .purple
        case .queries:
            self.label = "Queries"
            self.icon = "arrow.left.arrow.right"
            self.accent = .teal
        case .touches:
            self.label = "Touches"
            self.icon = "arrow.triangle.branch"
            self.accent = .blue
        case .excluded:
            self.label = "Out of Scope"
            self.icon = "nosign"
            self.accent = .red
        case .constraints:
            self.label = "Constraints"
            self.icon = "exclamationmark.triangle"
            self.accent = .orange
        case .tests:
            self.label = "Test Expectations"
            self.icon = "checkmark.seal"
            self.accent = .green
        case .generic:
            self.label = section.title
            self.icon = "doc.text"
            self.accent = .secondary
        }
    }
}

#Preview("Task cards") {
    ScrollView {
        TaskStructuredView(markdown: """
        # Task
        Add a narrow, extensible WorkPackage read service in Application.

        ## DTOs
        - `WorkPackageListItemDto`
        - `WorkPackageTreeSelectionDto`
        - `WorkPackageTreeItemDto`

        ## Service
        Create `IWorkPackageService` with read methods only. Do not add a repository.

        ## Queries
        - `GetWorkPackagesQuery`
        - `GetWorkPackageTreeQuery`

        ## Touches
        Same paths as frontmatter. Keep the service and DTO contract in Application.

        ## Does not touch
        No repository layer, legacy plugin files, frontend changes, or generated TypeScript.

        ## Constraints
        Preserve selected/disabled tree behavior, including direct selected child behavior and
        propagation from a selected parent.

        ## Test expectations
        - flat read returns only WorkPackage items
        - tree read marks selected package selected and disabled
        """)
        .padding(20)
    }
    .frame(width: 760, height: 680)
}

#Preview("Plain task") {
    TaskStructuredView(markdown: "Add a small API endpoint and tests.")
        .padding(20)
        .frame(width: 520, height: 180)
}
