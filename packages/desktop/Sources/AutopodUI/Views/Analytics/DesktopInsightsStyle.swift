import SwiftUI

extension EnvironmentValues {
    @Entry var desktopAnalyticsWindow: Int? = nil
}

struct DesktopAnalyticsBackground: View {
    @Environment(\.desktopRedesign) private var redesign
    var body: some View { redesign ? DesktopTheme.surface : Color(nsColor: .windowBackgroundColor) }
}

private struct DesktopAnalyticsPanel: ViewModifier {
    @Environment(\.desktopRedesign) private var redesign
    func body(content: Content) -> some View {
        if redesign {
            content.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(DesktopTheme.line))
        } else { content }
    }
}

extension View {
    func desktopAnalyticsPanel() -> some View { modifier(DesktopAnalyticsPanel()) }
}

struct DesktopInsightsHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let actions: () -> Actions
    private var context: String {
        switch title { case "History": "PAST WORK"; case "Memory": "KNOWLEDGE"; case "Managed pods": "DISPATCHER"; default: "FLEET INSIGHTS" }
    }
    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 7) {
                Text("WORKSPACE / \(context)")
                    .font(.system(size: 9, weight: .medium)).tracking(1.2).foregroundStyle(.secondary)
                Text(title).font(.system(size: 27, weight: .semibold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 10)
            actions().controlSize(.small)
        }.padding(28).background(DesktopTheme.surface)
        Rectangle().fill(DesktopTheme.line).frame(height: 1)
    }
}

extension AnalyticsCardKind {
    static let desktopCases: [Self] = [.cost, .reliability, .throughput, .quality, .safety, .escalations, .models, .memory, .status]
    var desktopLabel: String {
        switch self {
        case .cost: "Cost"
        case .quality: "Process health"
        case .status: "Status distribution"
        case .reliability: "Outcome quality"
        case .safety: "Safety"
        case .throughput: "Throughput"
        case .escalations: "Escalations"
        case .models: "Models"
        case .memory: "Memory loop"
        }
    }
    var desktopContext: String {
        switch self {
        case .cost: "Stored cost subtotal; billing unverified. Infrastructure cost is separate."
        case .quality: "Comparable execution-process scores. Validation outcomes are measured separately."
        case .status: "Current status of loaded pods, including workspace and active records."
        case .reliability: "Lifecycle outcomes, validation stages and first-pass success without rework."
        case .safety: "Recorded sanitization, network enforcement, host worktree and audit-chain evidence."
        case .throughput: "Completed work, queue measurements and recorded time in status."
        case .escalations: "Terminal-pod rates and resolved human-response times use distinct cohorts."
        case .models: "Recorded terminal cohorts are observational; differences do not establish model superiority."
        case .memory: "Reported memory usage and observed repeated-pain comparisons."
        }
    }
}

struct DesktopAnalyticsColumns<Content: View>: View {
    @Environment(\.desktopRedesign) private var redesign
    @ViewBuilder let content: () -> Content
    var body: some View {
        if redesign {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 500), alignment: .topLeading)], alignment: .leading, spacing: 20) { content() }
        } else { VStack(alignment: .leading, spacing: 24) { content() } }
    }
}
