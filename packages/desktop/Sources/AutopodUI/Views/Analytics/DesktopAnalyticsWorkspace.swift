import AutopodClient
import SwiftUI

public struct DesktopAnalyticsWorkspace: View {
    @Binding public var selected: AnalyticsCardKind?
    @Binding public var days: Int
    public let isConnected: Bool
    public let viewHistory: () -> Void
    public let overview: (Int) -> AnyView
    public let detail: (AnalyticsCardKind, Int) -> AnyView
    @State private var revision = UUID()
    public init(selected: Binding<AnalyticsCardKind?>, days: Binding<Int>, isConnected: Bool,
                viewHistory: @escaping () -> Void, overview: @escaping (Int) -> AnyView,
                detail: @escaping (AnalyticsCardKind, Int) -> AnyView) {
        _selected = selected; _days = days; self.isConnected = isConnected
        self.viewHistory = viewHistory; self.overview = overview; self.detail = detail
    }
    public var body: some View {
        VStack(spacing: 0) {
            DesktopInsightsHeader(title: "Analytics", subtitle: "Understand delivery, cost and execution from the evidence you have.") {
                HStack {
                    Button { revision = UUID() } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(!isConnected)
                    Button("View history ↗", action: viewHistory)
                }
            }
            if !isConnected {
                Label("Disconnected · recorded results may be stale. Reconnect to refresh.", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Text(selected == .status ? "Current loaded-pod snapshot · date window does not apply" : "All repositories · retained evidence included where supported")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Picker("Window", selection: $days) {
                    ForEach([7, 14, 30, 60, 90], id: \.self) { Text("Last \($0) days").tag($0) }
                }.fixedSize().controlSize(.small).disabled(selected == .status)
                    .accessibilityIdentifier("analytics-window")
            }.padding(.horizontal, 26).padding(.vertical, 13).background(DesktopTheme.canvas)
            if let selected {
                GeometryReader { geometry in
                    if geometry.size.width >= 1100 {
                        HStack(spacing: 0) {
                            ScrollView { categories }.frame(width: 180).background(DesktopTheme.canvas)
                            DesktopTheme.line.frame(width: 1)
                            drill(selected)
                        }
                    } else {
                        VStack(spacing: 0) {
                            ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 4) { categoryButtons } }.padding(12).background(DesktopTheme.canvas)
                            drill(selected)
                        }
                    }
                }
            } else {
                overview(days).id("overview-\(days)-\(revision)")
                    .environment(\.desktopAnalyticsWindow, days)
            }
        }.background(DesktopTheme.surface)
    }
    private var categories: some View { VStack(alignment: .leading, spacing: 5) { categoryButtons }.padding(14) }
    @ViewBuilder private var categoryButtons: some View {
        Button { selected = nil } label: { Text("← Overview").frame(maxWidth: .infinity, alignment: .leading) }
            .buttonStyle(.plain).font(.caption).padding(10)
        ForEach(AnalyticsCardKind.desktopCases, id: \.self) { card in
            Button { selected = card } label: {
                Text(card.desktopLabel).font(.caption).fixedSize(horizontal: true, vertical: false)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(selected == card ? DesktopTheme.accent : .secondary)
                    .background(selected == card ? DesktopTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 6))
            }.buttonStyle(.plain).accessibilityAddTraits(selected == card ? .isSelected : [])
        }
    }
    private func drill(_ card: AnalyticsCardKind) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(card.desktopContext).font(.caption).foregroundStyle(.secondary)
                .padding(.horizontal, 24).padding(.top, 18)
            detail(card, days).id("\(card.rawValue)-\(days)-\(revision)")
                .environment(\.desktopAnalyticsWindow, days)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
