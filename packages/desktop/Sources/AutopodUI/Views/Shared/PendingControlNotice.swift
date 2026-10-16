import SwiftUI

/// Request lifetime is independent of the daemon's confirmed lifecycle status.
struct PendingControlNotice: View {
    let kind: PendingPodControl
    let podId: String

    var body: some View {
        Label(kind.notice, systemImage: "clock")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("pod-control-notice-\(podId)")
    }
}
