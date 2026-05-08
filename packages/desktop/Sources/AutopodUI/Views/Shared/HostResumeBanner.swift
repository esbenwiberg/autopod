import AutopodClient
import SwiftUI

/// Transient banner shown for ~5 s when the daemon reports the host woke from sleep.
/// Self-dismisses via `.task`; tapping dismisses immediately.
public struct HostResumeBanner: View {
    let info: HostResumedInfo
    let onDismiss: () -> Void

    public init(info: HostResumedInfo, onDismiss: @escaping () -> Void) {
        self.info = info
        self.onDismiss = onDismiss
    }

    public var body: some View {
        Button(action: onDismiss) {
            Text(bannerText)
                .font(.caption.weight(.medium))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.15), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .task(id: info.sleptMs) {
            try? await Task.sleep(for: .seconds(5))
            onDismiss()
        }
    }

    private var bannerText: String {
        let duration = Self.formatDuration(info.sleptMs)
        if info.reconciledPodIds.isEmpty {
            return "Resumed after \(duration)"
        } else {
            let count = info.reconciledPodIds.count
            let podWord = count == 1 ? "pod" : "pods"
            return "Resumed after \(duration) — \(count) \(podWord) OK"
        }
    }

    static func formatDuration(_ ms: Int) -> String {
        let totalSeconds = ms / 1000
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60

        if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else if totalSeconds >= 300 {
            return "\(minutes)m"
        } else if totalSeconds >= 60 {
            return "\(minutes)m \(seconds)s"
        } else {
            return "\(totalSeconds)s"
        }
    }
}
