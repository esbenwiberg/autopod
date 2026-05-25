/// Discriminator for the selected card in the Analytics Overview grid.
/// Held as `@State` in MainView; consumed by AnalyticsView (to mark the
/// active card) and AnalyticsRightPaneView (to render the drill-in content).
public enum AnalyticsCardKind: String, Hashable {
    case cost, quality, status, reliability, safety, throughput, escalations, models, memory
}
