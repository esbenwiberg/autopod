import AppKit
import SwiftUI

/// The same saved string is used for display and copying, without normalization.
struct OverviewFailureReason: View {
    let detail: FailureDetail?
    var clipboardPayload: String? { detail?.reason }

    func copyReason(to pasteboard: NSPasteboard = .general) {
        guard let clipboardPayload else { return }
        pasteboard.clearContents()
        pasteboard.setString(clipboardPayload, forType: .string)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Recorded reason").font(.headline)
                Spacer()
                if clipboardPayload != nil {
                    Button("Copy reason") { copyReason() }
                        .accessibilityIdentifier("overview-copy-reason")
                }
            }
            if let reason = clipboardPayload {
                Text(verbatim: reason)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("overview-recorded-reason")
            } else {
                Text(detail == nil
                    ? "Full reason detail is pending or unavailable."
                    : "No reason was recorded.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
    }
}
