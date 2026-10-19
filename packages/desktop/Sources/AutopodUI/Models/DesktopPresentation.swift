import Foundation

/// A credential-free identity for display and filtering. The captured profile wins
/// over today's editable profile; missing snapshots use the current profile explicitly.
struct DesktopRepository: Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let isSnapshot: Bool

    init?(url raw: String, isSnapshot: Bool = true) {
        var normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.contains("://"), let at = normalized.firstIndex(of: "@"),
           let colon = normalized[at...].firstIndex(of: ":") {
            normalized = "ssh://" + normalized[..<colon] + "/" + normalized[normalized.index(after: colon)...]
        }
        guard let url = URLComponents(string: normalized),
              let host = url.host?.lowercased(), !host.isEmpty,
              ["https", "http", "ssh", "git"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        var path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path.hasSuffix(".git") { path.removeLast(4) }
        guard !path.isEmpty else { return nil }
        id = host + "/" + path
        let displayPath = path.replacingOccurrences(of: "/_git/", with: "/")
        label = ["github.com", "dev.azure.com"].contains(host) ? displayPath : host + "/" + displayPath
        self.isSnapshot = isSnapshot
    }

    static func resolve(_ pod: Pod, profiles: [Profile]) -> DesktopRepository? {
        if let captured = pod.fleetDisplay?.repository {
            guard captured.kind == "repository", let remote = captured.remote else { return nil }
            return Self(url: remote)
        }
        if let snapshot = pod.profileSnapshot { return Self(url: snapshot.repoUrl) }
        guard let profile = profiles.first(where: { $0.name == pod.profileName }) else { return nil }
        return Self(url: profile.repoUrl, isSnapshot: false)
    }
}

enum DesktopLifecycleStage: String, CaseIterable, Sendable {
    case queued = "Queued", provisioning = "Provisioning", running = "Running"
    case validating = "Validating", validated = "Validated", approved = "Approved"
    case merging = "Merging", complete = "Complete"
}

extension Pod {
    var desktopRepositoryPlaceholder: String {
        fleetDisplay?.repository.kind == "empty" ? "Empty workspace" : "Repository unavailable"
    }
    var desktopTitle: String {
        if let briefTitle, !briefTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return briefTitle }
        if let first = task.split(whereSeparator: \.isNewline).first {
            let line = String(first).replacingOccurrences(of: #"^\s*[#>*-]+\s*"#, with: "", options: .regularExpression)
            if !line.isEmpty { return line }
        }
        return plan?.summary ?? branch
    }
    var desktopMilestoneToken: String? {
        guard let phase, phase.total > 0, phase.current >= 0, phase.current <= phase.total else { return nil }
        return "M\(phase.current)/\(phase.total)"
    }
    var desktopLifecycleStage: DesktopLifecycleStage? {
        switch status {
        case .queued: .queued
        case .provisioning: .provisioning
        case .running, .paused, .awaitingInput, .handoff: .running
        case .validating: .validating
        case .validated, .reviewRequired: .validated
        case .approved: .approved
        case .merging, .mergePending: .merging
        case .complete: .complete
        case .failed, .killed, .killing: nil
        }
    }
    var desktopLifecycleStages: [DesktopLifecycleStage] {
        var stages: [DesktopLifecycleStage] = [.queued, .provisioning, .running]
        if pod.validate { stages += [.validating, .validated] }
        if pod.output == .pr { stages += [.approved, .merging] }
        stages += [.complete]
        return stages
    }
}
