/// Sub-route under the Analytics sidebar group.
///
/// Each phase of the analytics dashboard fills in one section. Phase 0 ships
/// `.overview`; later phases (cost, reliability, quality, safety) ship as
/// their drills are wired. Sections returning `isShipped == false` render as
/// `.disabled(true)` rows in the sidebar.
public enum AnalyticsSection: String, CaseIterable, Hashable, Sendable {
    case overview
    case cost
    case reliability
    case quality
    case safety
    case throughput
    case models

    public var isShipped: Bool {
        switch self {
        case .overview, .cost, .reliability, .quality, .safety: true
        case .throughput, .models: false
        }
    }

    public var label: String {
        switch self {
        case .overview: "Overview"
        case .cost: "Cost"
        case .reliability: "Reliability"
        case .quality: "Quality"
        case .safety: "Safety"
        case .throughput: "Throughput"
        case .models: "Models"
        }
    }

    public var icon: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .cost: "dollarsign.circle"
        case .reliability: "checkmark.shield"
        case .quality: "star.circle"
        case .safety: "lock.shield"
        case .throughput: "speedometer"
        case .models: "cpu"
        }
    }

    /// The card kind that should be auto-selected when navigating to this
    /// section. `.overview` clears the card; unshipped sections also clear
    /// (their rows are non-clickable anyway).
    public var preselectedCard: AnalyticsCardKind? {
        switch self {
        case .overview, .throughput, .models: nil
        case .cost: .cost
        case .reliability: .reliability
        case .quality: .quality
        case .safety: .safety
        }
    }
}
