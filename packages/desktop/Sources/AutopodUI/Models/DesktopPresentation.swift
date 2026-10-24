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

    enum Source: Equatable, Sendable {
        case captured(kind: String, remote: String?)
        case snapshot(String)
        case legacy(String?)

        func resolve(using normalize: (String, Bool) -> DesktopRepository? = {
            DesktopRepository(url: $0, isSnapshot: $1)
        }) -> DesktopRepository? {
            switch self {
            case .captured(let kind, let remote):
                guard kind == "repository", let remote else { return nil }
                return normalize(remote, true)
            case .snapshot(let remote): return normalize(remote, true)
            case .legacy(let remote):
                guard let remote else { return nil }
                return normalize(remote, false)
            }
        }
    }

    static func source(_ pod: Pod, legacyRemote: @autoclosure () -> String?) -> Source {
        if let captured = pod.fleetDisplay?.repository {
            return .captured(kind: captured.kind, remote: captured.remote)
        }
        if let snapshot = pod.profileSnapshot { return .snapshot(snapshot.repoUrl) }
        return .legacy(legacyRemote())
    }

    static func resolve(_ pod: Pod, profiles: [Profile]) -> DesktopRepository? {
        source(pod, legacyRemote: profiles.first { $0.name == pod.profileName }?.repoUrl).resolve()
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
