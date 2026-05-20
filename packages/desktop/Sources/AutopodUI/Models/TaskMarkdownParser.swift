import Foundation

struct TaskMarkdownDocument: Equatable {
    let sections: [TaskMarkdownSection]
    let explicitHeadingCount: Int

    var usesStructuredCards: Bool {
        explicitHeadingCount > 1 || sections.contains { $0.kind != .task }
    }
}

struct TaskMarkdownSection: Equatable, Identifiable {
    let id: Int
    let title: String
    let body: String
    let level: Int
    let kind: TaskMarkdownSectionKind
}

enum TaskMarkdownSectionKind: Equatable {
    case task
    case dtos
    case service
    case queries
    case touches
    case excluded
    case constraints
    case tests
    case generic
}

enum TaskMarkdownParser {
    static func parse(_ markdown: String) -> TaskMarkdownDocument {
        let normalizedMarkdown = markdown.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedMarkdown.split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)

        var sections: [TaskMarkdownSection] = []
        var currentTitle = "Task"
        var currentLevel = 0
        var currentLines: [String] = []
        var explicitHeadingCount = 0
        var isInsideFence = false

        func flushCurrentSection() {
            let body = trimmedMarkdown(currentLines)
            guard !body.isEmpty else { return }
            sections.append(
                TaskMarkdownSection(
                    id: sections.count,
                    title: currentTitle,
                    body: body,
                    level: currentLevel,
                    kind: kind(for: currentTitle)
                )
            )
        }

        for line in lines {
            if isFenceBoundary(line) {
                isInsideFence.toggle()
                currentLines.append(line)
                continue
            }

            if !isInsideFence, let heading = heading(in: line) {
                flushCurrentSection()
                currentTitle = heading.title
                currentLevel = heading.level
                currentLines = []
                explicitHeadingCount += 1
                continue
            }

            currentLines.append(line)
        }

        flushCurrentSection()

        return TaskMarkdownDocument(
            sections: sections,
            explicitHeadingCount: explicitHeadingCount
        )
    }

    private static func heading(in line: String) -> (level: Int, title: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return nil }

        let level = trimmed.prefix { $0 == "#" }.count
        guard (1...3).contains(level) else { return nil }

        let remainder = trimmed.dropFirst(level)
        guard remainder.first?.isWhitespace == true else { return nil }

        let title = cleanedHeadingTitle(String(remainder))
        guard !title.isEmpty else { return nil }

        return (level, title)
    }

    private static func cleanedHeadingTitle(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix("#") else { return trimmed }

        let characters = Array(trimmed)
        var index = characters.count - 1
        while index >= 0, characters[index] == "#" {
            index -= 1
        }

        guard index >= 0, characters[index].isWhitespace else { return trimmed }
        return String(characters[0..<index]).trimmingCharacters(in: .whitespaces)
    }

    private static func trimmedMarkdown(_ lines: [String]) -> String {
        var start = 0
        var end = lines.count

        while start < end, lines[start].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            start += 1
        }
        while end > start, lines[end - 1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            end -= 1
        }

        guard start < end else { return "" }
        return lines[start..<end].joined(separator: "\n")
    }

    private static func isFenceBoundary(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
    }

    private static func kind(for title: String) -> TaskMarkdownSectionKind {
        switch normalizedHeading(title) {
        case "task":
            return .task
        case "dto", "dtos", "data transfer objects":
            return .dtos
        case "service", "read service", "workpackage service":
            return .service
        case "query", "queries", "mediatr queries", "read queries":
            return .queries
        case "touches", "touch points", "files touched":
            return .touches
        case "does not touch", "doesnt touch", "out of scope", "not in scope", "excluded":
            return .excluded
        case "constraint", "constraints":
            return .constraints
        case "test expectations", "testing expectations", "tests", "test plan":
            return .tests
        default:
            return .generic
        }
    }

    private static func normalizedHeading(_ title: String) -> String {
        var result = ""
        var previousWasSpace = false

        for scalar in title.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                result.unicodeScalars.append(scalar)
                previousWasSpace = false
            } else if isHeadingSeparator(scalar) {
                if !previousWasSpace, !result.isEmpty {
                    result.append(" ")
                    previousWasSpace = true
                }
            }
        }

        return result.trimmingCharacters(in: .whitespaces)
    }

    private static func isHeadingSeparator(_ scalar: UnicodeScalar) -> Bool {
        scalar == " " || scalar == "\t" || scalar == "-" || scalar == "_" || scalar == "/"
    }
}
