import AppKit
import SwiftUI

public enum RelatedEventLoadState: Equatable, Sendable {
    case notLoaded
    case loading
    case loaded
    case failed(String)
}

struct RelatedEventReference: Identifiable, Sendable {
    let id: String
    let relationship: String
    let pod: Pod?
}

struct RelatedEventsDebugSheet: View {
    let currentPodId: String
    let references: [RelatedEventReference]
    var eventsForPod: (String) -> [AgentEvent]
    var loadStateForPod: (String) -> RelatedEventLoadState
    var loadEventsForPod: ((String) -> Void)?
    var onOpenPod: ((String) -> Void)?
    var onOpenLogs: ((String) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var selectedPodId: String?

    private var selectedReference: RelatedEventReference? {
        guard let selectedPodId else { return references.first }
        return references.first { $0.id == selectedPodId } ?? references.first
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack(spacing: 0) {
                referenceList
                    .frame(width: 245)
                Divider()
                if let selectedReference {
                    eventPane(for: selectedReference)
                } else {
                    emptyPane
                }
            }
        }
        .frame(minWidth: 760, idealWidth: 860, minHeight: 430, idealHeight: 520)
        .onAppear {
            if selectedPodId == nil {
                selectedPodId = references.first?.id
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(.secondary)
            Text("Related Events")
                .font(.headline)
            Spacer()
            Text(currentPodId)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var referenceList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(references) { reference in
                    referenceRow(reference)
                }
            }
            .padding(10)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func referenceRow(_ reference: RelatedEventReference) -> some View {
        let selected = (selectedReference?.id ?? references.first?.id) == reference.id
        return Button {
            selectedPodId = reference.id
        } label: {
            HStack(alignment: .top, spacing: 8) {
                if let pod = reference.pod {
                    StatusDot(status: pod.status)
                        .padding(.top, 2)
                } else {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                        .frame(width: 14, height: 14)
                        .padding(.top, 2)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(reference.id)
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(reference.relationship)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let pod = reference.pod {
                        Text(pod.status.label)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Color.accentColor.opacity(0.14) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private func eventPane(for reference: RelatedEventReference) -> some View {
        let events = eventsForPod(reference.id)
        let state = loadStateForPod(reference.id)
        let visibleEvents = Array(events.filter { !$0.type.isNoise }.suffix(14))

        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reference.id)
                            .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(reference.relationship)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    diagnosticBadge(state: state, events: events)
                }

                if case .failed(let message) = state {
                    Text(message)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .lineLimit(3)
                }
            }
            .padding(14)

            Divider()

            if visibleEvents.isEmpty {
                emptyEventsView(state: state, eventCount: events.count)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(visibleEvents) { event in
                            eventRow(event)
                            if event.id != visibleEvents.last?.id {
                                Divider().padding(.leading, 28)
                            }
                        }
                    }
                    .padding(12)
                }
            }

            Divider()
            footer(for: reference, state: state)
        }
    }

    private func diagnosticBadge(state: RelatedEventLoadState, events: [AgentEvent]) -> some View {
        let label = diagnosticLabel(state: state, events: events)
        let color = diagnosticColor(state: state, events: events)
        return Text(label)
            .font(.system(.caption2, design: .monospaced).weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
            .lineLimit(1)
    }

    private func diagnosticLabel(state: RelatedEventLoadState, events: [AgentEvent]) -> String {
        switch state {
        case .notLoaded:
            return "not loaded"
        case .loading:
            return "loading"
        case .failed:
            return "failed"
        case .loaded:
            if events.isEmpty { return "loaded, zero events" }
            if events.allSatisfy({ !$0.type.isOverviewWorthy }) {
                return "loaded, filtered"
            }
            return "loaded, \(events.count) events"
        }
    }

    private func diagnosticColor(state: RelatedEventLoadState, events: [AgentEvent]) -> Color {
        switch state {
        case .notLoaded:
            return .secondary
        case .loading:
            return .blue
        case .failed:
            return .red
        case .loaded:
            return events.isEmpty ? .orange : .green
        }
    }

    private func eventRow(_ event: AgentEvent) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: event.type.icon)
                .font(.system(size: 10))
                .foregroundStyle(event.type.color)
                .frame(width: 16)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(event.timeString)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                    Text(event.type.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(event.type.color)
                }
                Text(event.summary)
                    .font(.caption)
                    .lineLimit(2)
                    .textSelection(.enabled)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
    }

    private func emptyEventsView(state: RelatedEventLoadState, eventCount: Int) -> some View {
        VStack(spacing: 10) {
            Image(systemName: emptyIcon(state: state, eventCount: eventCount))
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(emptyTitle(state: state, eventCount: eventCount))
                .font(.subheadline.weight(.semibold))
            Text(emptyMessage(state: state, eventCount: eventCount))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(24)
    }

    private func emptyIcon(state: RelatedEventLoadState, eventCount: Int) -> String {
        if eventCount > 0 { return "line.3.horizontal.decrease.circle" }
        switch state {
        case .notLoaded: return "tray"
        case .loading: return "arrow.clockwise"
        case .failed: return "exclamationmark.triangle"
        case .loaded: return "tray"
        }
    }

    private func emptyTitle(state: RelatedEventLoadState, eventCount: Int) -> String {
        if eventCount > 0 { return "Only filtered events are cached" }
        switch state {
        case .notLoaded: return "Events not loaded"
        case .loading: return "Loading events"
        case .failed: return "Could not load events"
        case .loaded: return "No events returned"
        }
    }

    private func emptyMessage(state: RelatedEventLoadState, eventCount: Int) -> String {
        if eventCount > 0 {
            return "The daemon returned events, but the visible list filters out low-signal noise."
        }
        switch state {
        case .notLoaded:
            return "This related pod has an ID, but the desktop has not fetched historical events yet."
        case .loading:
            return "Waiting for the daemon event history response."
        case .failed:
            return "The event history request failed. Retry after checking the daemon connection."
        case .loaded:
            return "The daemon returned an empty event history for this pod."
        }
    }

    private func footer(for reference: RelatedEventReference, state: RelatedEventLoadState) -> some View {
        HStack(spacing: 8) {
            Button {
                loadEventsForPod?(reference.id)
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loadEventsForPod == nil || state == .loading)

            Spacer()

            Button {
                dismiss()
                onOpenPod?(reference.id)
            } label: {
                Label("Open Pod", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(onOpenPod == nil)

            Button {
                dismiss()
                onOpenLogs?(reference.id)
            } label: {
                Label("Open Logs", systemImage: "text.line.last.and.arrowtriangle.forward")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(onOpenLogs == nil)
        }
        .padding(12)
    }

    private var emptyPane: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text("No related pods")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
