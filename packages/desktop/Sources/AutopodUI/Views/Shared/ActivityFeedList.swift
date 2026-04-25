import SwiftUI

/// Reusable activity feed — filtered to overview-worthy events, with tap-to-expand
/// detail rows and timestamps. Used by `OverviewTab` and the Series-tab slide-in panel.
public struct ActivityFeedList: View {
    public let events: [AgentEvent]
    public let maxCount: Int
    public let showHeader: Bool
    public let title: String

    public init(
        events: [AgentEvent],
        maxCount: Int = 6,
        showHeader: Bool = true,
        title: String = "Recent Activity"
    ) {
        self.events = events
        self.maxCount = maxCount
        self.showHeader = showHeader
        self.title = title
    }

    @State private var expandedEventId: Int?

    private var visibleEvents: [AgentEvent] {
        Array(events.filter { $0.type.isOverviewWorthy }.suffix(maxCount))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showHeader {
                HStack {
                    Text(title)
                        .font(.system(.subheadline).weight(.semibold))
                    Spacer()
                    Text("\(events.count) event\(events.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            if visibleEvents.isEmpty {
                Text("No activity yet")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 8)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(visibleEvents) { event in
                        let isExpanded = expandedEventId == event.id
                        Button {
                            withAnimation(.easeOut(duration: 0.15)) {
                                expandedEventId = isExpanded ? nil : event.id
                            }
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: event.type.icon)
                                    .font(.system(size: 9))
                                    .foregroundStyle(event.type.color)
                                    .frame(width: 14)
                                    .padding(.top, 2)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(event.summary)
                                        .font(.caption)
                                        .lineLimit(isExpanded ? nil : 1)
                                        .truncationMode(.tail)
                                        .fixedSize(horizontal: false, vertical: isExpanded)
                                    if isExpanded, let detail = event.detail {
                                        Text(detail)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .textSelection(.enabled)
                                            .padding(6)
                                            .background(Color(nsColor: .windowBackgroundColor))
                                            .clipShape(RoundedRectangle(cornerRadius: 4))
                                    }
                                    Text(event.timeString)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if event.id != visibleEvents.last?.id {
                            Divider().padding(.leading, 28)
                        }
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

#Preview("Activity feed — populated") {
    ActivityFeedList(events: MockEvents.running)
        .frame(width: 360)
        .padding()
}

#Preview("Activity feed — empty") {
    ActivityFeedList(events: [])
        .frame(width: 360)
        .padding()
}
