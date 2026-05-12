import SwiftUI

/// Popover listing messages queued for the next fix-pod iteration.
/// Shown when the user taps the Queue chip on a merge_pending pod card.
/// Data comes from `pod.recentQueueMessages` (populated via WS pod-update).
struct FixQueuePopover: View {
    let messages: [PodQueueMessage]

    private let relativeFmt: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Text("Queued for next iteration")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 8)

            Divider()

            if messages.isEmpty {
                Text("No messages queued.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(messages) { msg in
                            HStack(alignment: .top, spacing: 6) {
                                Text("•")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 1)
                                Text(msg.message)
                                    .font(.caption)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 8)
                                Text(relativeFmt.localizedString(for: msg.createdAt, relativeTo: Date()))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .monospacedDigit()
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
                .frame(maxHeight: 240)
            }

            Divider()

            // Footer
            Text("Drains when current fix pod completes")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 14)
                .padding(.top, 6)
                .padding(.bottom, 10)
        }
        .frame(width: 360)
    }
}
