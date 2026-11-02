import Foundation

/// A credential-free identity for display and filtering. The captured profile wins
/// over today's editable profile; missing snapshots use the current profile explicitly.
struct DesktopRepository: Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let isSnapshot: Bool

    /// Short card label only; filtering/search retain the full credential-free identity.
    var name: String { label.split(separator: "/").last.map(String.init) ?? label }

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
    var desktopCardMetadata: String {
        let name = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        let opaque = UUID(uuidString: name) != nil
            || name.range(of: #"^profile-[0-9a-fA-F]{24}$"#, options: .regularExpression) != nil
        return name.isEmpty || opaque ? model : "\(name) · \(model)"
    }

    /// Recorded running/validating state time. Never infer missing history from pod age.
    func desktopActiveDuration(at date: Date) -> String {
        guard let time = fleetDisplay?.activeTime, time.elapsedMs.isFinite, time.elapsedMs >= 0 else {
            return "Active —"
        }
        var seconds = time.elapsedMs / 1000
        if let since = time.activeSince {
            // A status event may arrive ahead of the refreshed timing projection.
            guard status == .running || status == .validating,
                  let start = (try? Date(since, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
                    ?? (try? Date(since, strategy: .iso8601)), start <= date else { return "Active —" }
            seconds += date.timeIntervalSince(start)
        }
        // Bound conversion even when talking to a malformed/older daemon.
        guard seconds.isFinite, seconds < Double(Int.max / 1000) else { return "Active —" }
        let minutes = Int(seconds / 60)
        if seconds == 0 { return "Active 0m" }
        if minutes == 0 { return "Active <1m" }
        if minutes < 60 { return "Active \(minutes)m" }
        return "Active \(minutes / 60)h \(minutes % 60)m"
    }

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
