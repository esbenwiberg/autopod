/// Sub-route enum for the Analytics section of the sidebar.
public enum AnalyticsSection: String, CaseIterable, Hashable {
    case overview
    case cost
    case reliability
    case quality
    case safety
    case throughput
    case models

    /// True only for `.overview`. Sidebar rows for sections returning `false`
    /// are rendered with `.disabled(true)` and are non-interactive.
    public var isShipped: Bool {
        self == .overview
    }

    public var label: String {
        switch self {
        case .overview:    "Overview"
        case .cost:        "Cost"
        case .reliability: "Reliability"
        case .quality:     "Quality"
        case .safety:      "Safety"
        case .throughput:  "Throughput"
        case .models:      "Models"
        }
    }

    public var icon: String {
        switch self {
        case .overview:    "square.grid.2x2"
        case .cost:        "dollarsign.circle"
        case .reliability: "checkmark.shield"
        case .quality:     "star.circle"
        case .safety:      "lock.shield"
        case .throughput:  "speedometer"
        case .models:      "cpu"
        }
    }

    /// Phase number in which this section ships. Used for placeholder text.
    var phaseNumber: Int {
        switch self {
        case .overview:    0
        case .cost:        1
        case .reliability: 2
        case .quality:     3
        case .safety:      4
        case .throughput:  5
        case .models:      6
        }
    }
}
