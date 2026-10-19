import Foundation

struct DesktopHistoryFilter {
    var query = ""
    var repository = "all"
    var profile = "all"
    var outcome = "all"
    var days = 30

    func matches(_ pod: Pod, repository: DesktopRepository?, now: Date) -> Bool {
        guard !pod.isWorkspace else { return false }
        if days > 0, pod.startedAt < now.addingTimeInterval(-Double(days) * 86400) { return false }
        if self.repository == "unknown" { guard repository == nil else { return false } }
        else if self.repository != "all", repository?.id != self.repository { return false }
        if profile != "all", pod.profileName != profile { return false }
        if outcome == "attention" {
            guard Self.needsAttention(pod) else { return false }
        } else if outcome != "all", pod.status.rawValue != outcome { return false }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return needle.isEmpty || [pod.id, pod.desktopTitle, pod.task, repository?.label ?? pod.desktopRepositoryPlaceholder,
            pod.profileName, pod.errorSummary ?? ""].joined(separator: " ").localizedStandardContains(needle)
    }
    static func needsAttention(_ pod: Pod) -> Bool {
        [.failed, .killed, .reviewRequired].contains(pod.status)
    }
}
