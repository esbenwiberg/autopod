import Testing
@testable import AutopodUI

// MARK: - Toggle-off semantics

@Test func toggleOffCostCard() {
    var card: AnalyticsCardKind? = nil
    // First click selects
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
    // Second click on the same card deselects
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == nil)
}

@Test func toggleOffQualityCard() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == .quality)
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == nil)
}

@Test func toggleOffStatusCard() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == .status)
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == nil)
}

// MARK: - Switch-drill semantics (no nil intermediate)

@Test func switchDrillCostToQuality() {
    var card: AnalyticsCardKind? = nil
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
    // Clicking Quality while Cost is selected switches directly — no nil intermediate
    card = MainView.toggleAnalyticsCard(card, tapping: .quality)
    #expect(card == .quality)
}

@Test func switchDrillQualityToStatus() {
    var card: AnalyticsCardKind? = .quality
    card = MainView.toggleAnalyticsCard(card, tapping: .status)
    #expect(card == .status)
}

@Test func switchDrillStatusToCost() {
    var card: AnalyticsCardKind? = .status
    card = MainView.toggleAnalyticsCard(card, tapping: .cost)
    #expect(card == .cost)
}

// MARK: - onSelectPod handler

@Test func analyticsSelectPodClearsCardAndNavigates() {
    let result = MainView.analyticsSelectPodResult(sessionId: "abc123")
    #expect(result.card == nil)
    #expect(result.sidebar == .all)
    #expect(result.session == "abc123")
}

@Test func analyticsSelectPodWithDifferentSessionId() {
    let result = MainView.analyticsSelectPodResult(sessionId: "xyz-pod-9876")
    #expect(result.card == nil)
    #expect(result.sidebar == .all)
    #expect(result.session == "xyz-pod-9876")
}
